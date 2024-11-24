import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { Logger } from 'homebridge';
import fetch from 'node-fetch';
import { URLSearchParams } from 'url';


export interface Tokens {
	userIndex: number | null;
	accessToken: string | null;
	refreshToken: string | null;
	tokenExpiration: number | null;
}

export interface Device {
	id: string;
	IMEI: string;
	// Add other device properties as needed
}

interface authProps {
	userEmailPhone: string;
	userPass: string;
	log: Logger;
}

export class Auth {
	private userEmailPhone: string;
	private userPass: string;
	private log: Logger;

	private userIndex: number | null = null;
	private accessToken: string | null = null;
	private refreshToken: string | null = null;
	private tokenExpiration: number | null = null;
	private devices: Device[] = [];
	private tokensFilePath: string;

	constructor({userEmailPhone, userPass, log}: authProps) {
		this.userEmailPhone = userEmailPhone;
		this.userPass = userPass;
		this.log = log;

		// Set tokens file path (e.g., ~/.olarmws-plugin/tokens.json)
		this.tokensFilePath = path.join(os.homedir(), '.olarmws-plugin', 'tokens.json');

		// Ensure directory exists
		fs.ensureDirSync(path.dirname(this.tokensFilePath));
	}

	public async initialize() {
		await this.loadTokensFromStorage();

		if (!this.accessToken || !this.refreshToken) {
			await this.login();
		} else {
			// Optionally refresh the access token if it's expired
			await this.ensureAccessToken();
		}
		await this.fetchDevices()
	}

	public getTokens(): Tokens {
		return {
			userIndex: this.userIndex,
			accessToken: this.accessToken,
			refreshToken: this.refreshToken,
			tokenExpiration: this.tokenExpiration,
		};
	}

	// Authentication methods

	private async login() {
		this.log.info('--- Logging In ---');
		const response = await fetch(
			'https://auth.olarm.com/api/v4/oauth/login/mobile',
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					userEmailPhone: this.userEmailPhone,
					userPass: this.userPass,
				}).toString(),
			},
		);
		if (!response.ok) {
			throw new Error('Login failed');
		}
		const data = await response.json();
		this.accessToken = data.oat;
		this.refreshToken = data.ort;
		this.tokenExpiration = data.oatExpire;
		await this.fetchUserIndex(); // Fetch user index after login
		await this.saveTokensToStorage();
	}

	private async fetchUserIndex() {
		if (!this.accessToken) {
			throw new Error(`"fetching user index", ${this.accessToken}`);
		}
		const url = `https://auth.olarm.com/api/v4/oauth/federated-link-existing?oat=${this.accessToken}`;
		const formData = new URLSearchParams({
			userEmailPhone: this.userEmailPhone,
			userPass: this.userPass,
			captchaToken: 'olarmapp',
		});
		const response = await fetch(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/x-www-form-urlencoded'},
			body: formData.toString(),
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Failed to fetch user index: ${response.status} ${response.statusText} - ${errorText}`,
			);
		}
		const data = await response.json();
		this.log.debug(`We have the user index: ${data.userIndex}`);
		this.userIndex = data.userIndex;
	}

	private async fetchDevices() {
		if (!this.accessToken || !this.userIndex) {
			throw new Error('Access token or user index is missing');
		}

		const url = `https://api-legacy.olarm.com/api/v2/users/${this.userIndex}`;
		const response = await fetch(url, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Failed to fetch devices: ${response.status} ${response.statusText} - ${errorText}`
			);
		}

		const data = await response.json();
		this.devices = data.devices.map((device: any) => ({
			id: device.id,
			IMEI: device.IMEI,
			// Map other necessary properties
		}));

		this.log.debug(`Fetched devices: ${JSON.stringify(this.devices, null, 2)}`);
	}

	// Add getter to retrieve the devices
	public getDevices(): Device[] {
		return this.devices;
	}

	private async refreshAccessToken() {
		if (!this.refreshToken) {
			this.log.error('No stored refresh token, logging in...', this.refreshToken);
			await this.login();
			return;
		}
		const response = await fetch('https://auth.olarm.com/api/v4/oauth/refresh', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ort: this.refreshToken}).toString(),
		});
		if (!response.ok) {
			throw new Error('Token refresh failed');
		}
		const data = await response.json();
		this.log.info("[accessToken]", data.oat)
		this.accessToken = data.oat;
		this.refreshToken = data.ort;
		this.tokenExpiration = data.oatExpire;
		await this.saveTokensToStorage();
	}

	private async ensureAccessToken() {
		if (!this.accessToken || Date.now() >= this.tokenExpiration!) {
			await this.refreshAccessToken();
		}
	}

	// Storage methods
	private async loadTokensFromStorage() {
		try {
			if (fs.existsSync(this.tokensFilePath)) {
				const tokens: Tokens = await fs.readJSON(this.tokensFilePath);
				this.userIndex = tokens.userIndex;
				this.accessToken = tokens.accessToken;
				this.refreshToken = tokens.refreshToken;
				this.tokenExpiration = tokens.tokenExpiration;
			} else {
				this.log.debug('No tokens found in storage');
			}
		} catch (error) {
			this.log.error('Failed to load tokens from storage:', error);
			this.userIndex = null;
			this.accessToken = null;
			this.refreshToken = null;
			this.tokenExpiration = null;
		}
	}

	private async saveTokensToStorage() {
		if (
			this.accessToken &&
			this.refreshToken &&
			this.tokenExpiration &&
			this.userIndex !== null
		) {
			const tokens = {
				userIndex: this.userIndex,
				accessToken: this.accessToken,
				refreshToken: this.refreshToken,
				tokenExpiration: this.tokenExpiration,
			};
			try {
				await fs.writeJSON(this.tokensFilePath, tokens);
				this.log.debug('Tokens saved to storage');
			} catch (error) {
				this.log.error('Failed to save tokens to storage:', error);
			}
		} else {
			this.log.warn('Skipping saving tokens to storage due to missing values');
		}
	}
	// end
}
import {Logger} from 'homebridge';
import fetch from 'node-fetch';
import {URLSearchParams} from 'url';
import * as storage from 'node-persist';

export interface Tokens {
	userIndex: number | null;
	accessToken: string | null;
	refreshToken: string | null;
	tokenExpiration: number | null;
}

export class Auth {
	private userEmailPhone: string;
	private userPass: string;
	private storage: storage.LocalStorage;
	private log: Logger;

	private userIndex: number | null = null;
	private accessToken: string | null = null;
	private refreshToken: string | null = null;
	private tokenExpiration: number | null = null;

	constructor({
								userEmailPhone,
								userPass,
								storage,
								log,
							}: {
		userEmailPhone: string;
		userPass: string;
		storage: storage.LocalStorage;
		log: Logger;
	}) {
		this.userEmailPhone = userEmailPhone;
		this.userPass = userPass;
		this.storage = storage;
		this.log = log;
	}

	public async initialize() {
		await this.loadTokensFromStorage();

		if (!this.accessToken || !this.refreshToken) {
			await this.login();
		} else {
			// Optionally refresh the access token if it's expired
			await this.ensureAccessToken();
		}
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
			const tokens: Tokens = await this.storage.getItem('tokens');
			if (tokens) {
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
				await this.storage.setItem('tokens', tokens);
				this.log.debug('Tokens saved to storage');
			} catch (error) {
				this.log.error('Failed to save tokens to storage:', error);
			}
		} else {
			this.log.warn('Skipping saving tokens to storage due to missing values');
		}
	}
}
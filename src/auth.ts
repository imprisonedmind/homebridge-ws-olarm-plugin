import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { Logger } from 'homebridge';
import fetch, { Response } from 'node-fetch'; // Import Response type
import { URLSearchParams } from 'url';


export interface Tokens {
	userIndex: number | null;
	userId: string | null;
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
	private userId: string | null = null;
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
		this.log.debug("Auth: Loading tokens from storage...");
		await this.loadTokensFromStorage();

		if (!this.accessToken || !this.refreshToken) {
			this.log.info("Auth: No valid tokens found in storage, attempting login...");
			await this.login();
		} else {
			this.log.debug("Auth: Found tokens in storage. Ensuring access token is valid...");
			// Optionally refresh the access token if it's expired or close to expiry
			await this.ensureAccessToken();

			// Ensure userIndex and userId are set (might be missing if loaded from old storage)
			if (this.userIndex === null || this.userId === null) {
				this.log.info("Auth: User index/ID missing, fetching...");
				await this.fetchUserIndex();
				await this.saveTokensToStorage(); // Save updated tokens with userId
			}
			this.log.debug("Auth: Access token appears valid.");
		}
		this.log.debug("Auth: Fetching devices...");
		await this.fetchDevices();
		this.log.info("Auth: Initialization complete.");
	}

	public getTokens(): Tokens {
		return {
			userIndex: this.userIndex,
			userId: this.userId,
			accessToken: this.accessToken,
			refreshToken: this.refreshToken,
			tokenExpiration: this.tokenExpiration,
		};
	}

	// Helper function to handle fetch errors
	private async handleFetchError(operation: string, response: Response): Promise<Error> {
		let errorText = `Status: ${response.status} ${response.statusText}`;
		try {
			const body = await response.text();
			errorText += ` - Body: ${body.substring(0, 500)}${body.length > 500 ? '...' : ''}`; // Log part of the body
		} catch (e) {
			// Ignore if reading body fails
		}
		const errorMessage = `Auth: ${operation} failed. ${errorText}`;
		this.log.error(errorMessage);
		return new Error(errorMessage);
	}


	// Authentication methods
	private async login() {
		this.log.info('Auth: Attempting login...');
		let response: Response;
		try {
			response = await fetch(
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
		} catch (error) {
			this.log.error(`Auth: Network or fetch error during login: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error(`Auth: Network or fetch error during login`);
		}

		if (!response.ok) {
			throw await this.handleFetchError("Login", response);
		}

		try {
			const data = await response.json();
			this.accessToken = data.oat;
			this.refreshToken = data.ort;
			// Convert seconds to milliseconds timestamp if oatExpire is in seconds
			this.tokenExpiration = (data.oatExpire && typeof data.oatExpire === 'number') ? data.oatExpire * 1000 : null;
			this.log.info('Auth: Login successful.');
			this.log.debug(`Auth: Access token expires around: ${this.tokenExpiration ? new Date(this.tokenExpiration).toISOString() : 'N/A'}`);
			await this.fetchUserIndex(); // Fetch user index after successful login
			await this.saveTokensToStorage();
		} catch (error) {
			this.log.error(`Auth: Error processing login response: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error("Auth: Failed to process login response");
		}
	}

	private async fetchUserIndex() {
		this.log.debug("Auth: Fetching user index/ID...");
		if (!this.accessToken) {
			this.log.error("Auth: Cannot fetch user index without an access token.");
			throw new Error("Auth: Cannot fetch user index, access token missing");
		}
		const url = `https://auth.olarm.com/api/v4/oauth/federated-link-existing?oat=${this.accessToken}`;
		const formData = new URLSearchParams({
			userEmailPhone: this.userEmailPhone,
			userPass: this.userPass,
			captchaToken: 'olarmapp', // This might need updating if Olarm changes things
		});

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded'},
				body: formData.toString(),
			});
		} catch (error) {
			this.log.error(`Auth: Network or fetch error during user index fetch: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error(`Auth: Network or fetch error during user index fetch`);
		}

		if (!response.ok) {
			throw await this.handleFetchError("Fetch user index", response);
		}

		try {
			const data = await response.json();
			this.log.debug(`Auth: User index response data:`, data); // Log the response
			if (data && typeof data.userIndex !== 'undefined' && typeof data.userId !== 'undefined') {
				this.userIndex = data.userIndex;
				this.userId = data.userId;
				this.log.info(`Auth: Successfully fetched user index: ${this.userIndex}, userId: ${this.userId}`);
			} else {
				this.log.error("Auth: User index/ID not found in response data:", data);
				throw new Error("Auth: User index/ID missing in response");
			}
		} catch (error) {
			this.log.error(`Auth: Error processing user index response: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error("Auth: Failed to process user index response");
		}
	}

	private async fetchDevices() {
		this.log.debug("Auth: Fetching devices list...");
		if (!this.accessToken || this.userIndex === null) { // Check userIndex specifically
			this.log.error('Auth: Cannot fetch devices, access token or user index is missing.');
			throw new Error('Auth: Access token or user index is missing for fetching devices');
		}

		const url = `https://api-legacy.olarm.com/api/v2/users/${this.userIndex}`;
		let response: Response;
		try {
			response = await fetch(url, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${this.accessToken}`,
				},
			});
		} catch (error) {
			this.log.error(`Auth: Network or fetch error during device fetch: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error(`Auth: Network or fetch error during device fetch`);
		}


		if (!response.ok) {
			// If unauthorized (401), maybe the token just expired? Try refreshing once.
			if (response.status === 401) {
				this.log.warn("Auth: Fetch devices returned 401 Unauthorized. Attempting token refresh...");
				try {
					await this.refreshAccessToken();
					// Retry fetchDevices after successful refresh
					this.log.info("Auth: Token refreshed successfully. Retrying fetch devices...");
					await this.fetchDevices(); // Recursive call, potential for infinite loop if refresh always fails
					return; // Exit after successful retry
				} catch (refreshError) {
					this.log.error("Auth: Token refresh failed after 401 on fetch devices. Giving up.", refreshError);
					// Throw the original error after failing to refresh
					throw await this.handleFetchError("Fetch devices (after refresh attempt)", response);
				}
			}
			// For other errors, just throw
			throw await this.handleFetchError("Fetch devices", response);
		}

		try {
			const data = await response.json();
			if (data && Array.isArray(data.devices)) {
				this.devices = data.devices.map((device: any) => ({
					id: device.id, // Assuming 'id' is the correct field from Olarm API
					IMEI: device.IMEI,
					// Map other necessary properties if needed
				}));
				this.log.info(`Auth: Successfully fetched ${this.devices.length} device(s).`);
				this.log.debug(`Auth: Fetched devices: ${JSON.stringify(this.devices, null, 2)}`);
			} else {
				this.log.error("Auth: Unexpected response format when fetching devices:", data);
				this.devices = [];
			}
		} catch (error) {
			this.log.error(`Auth: Error processing devices response: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error("Auth: Failed to process devices response");
		}
	}

	// Add getters for userIndex and userId
	public getUserIndex(): number | null {
		return this.userIndex;
	}

	public getUserId(): string | null {
		return this.userId;
	}

	public getDevices(): Device[] {
		// Return a shallow copy
		return [...this.devices];
	}

	private async refreshAccessToken() {
		this.log.info("Auth: Attempting to refresh access token...");
		if (!this.refreshToken) {
			this.log.error(
				"Auth: No refresh token available. Cannot refresh. Need to log in again.",
			);
			// Instead of logging in directly here (could cause loops), throw an error
			// The caller (e.g., initialize or ensureAccessToken) should handle this by triggering login.
			throw new Error("Auth: Refresh token missing, cannot refresh.");
		}
		let response: Response;
		try {
			response = await fetch(
				"https://auth.olarm.com/api/v4/oauth/refresh",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({ ort: this.refreshToken }).toString(),
				}
			);
		} catch (error) {
			this.log.error(`Auth: Network or fetch error during token refresh: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error(`Auth: Network or fetch error during token refresh`);
		}


		if (!response.ok) {
			// If refresh fails (e.g., refresh token expired/invalid), clear tokens and throw
			this.log.error("Auth: Token refresh failed. Clearing stored tokens.");
			this.clearTokens(); // Clear invalid tokens
			await this.saveTokensToStorage(); // Save the cleared state
			throw await this.handleFetchError("Token refresh", response);
		}

		try {
			const data = await response.json();
			this.accessToken = data.oat;
			this.refreshToken = data.ort; // Olarm might return a new refresh token
			this.tokenExpiration = (data.oatExpire && typeof data.oatExpire === 'number') ? data.oatExpire * 1000 : null;
			this.log.info("Auth: Access token refreshed successfully.");
			this.log.debug(`Auth: New access token expires around: ${this.tokenExpiration ? new Date(this.tokenExpiration).toISOString() : 'N/A'}`);

			// Fetch userIndex and userId if they are missing (shouldn't happen if refresh worked, but good safety check)
			if (this.userIndex === null || this.userId === null) {
				this.log.warn("Auth: User index/ID still missing after token refresh, attempting to fetch...");
				await this.fetchUserIndex();
			}

			await this.saveTokensToStorage();
		} catch (error) {
			this.log.error(`Auth: Error processing token refresh response: ${error instanceof Error ? error.message : String(error)}`);
			throw new Error("Auth: Failed to process token refresh response");
		}
	}

	private async ensureAccessToken() {
		const now = Date.now();
		// Check if token exists and hasn't expired (add a buffer, e.g., 5 minutes = 300,000 ms)
		const buffer = 5 * 60 * 1000;
		if (!this.accessToken || !this.tokenExpiration || now >= (this.tokenExpiration - buffer)) {
			if (!this.accessToken) {
				this.log.warn("Auth: Access token missing.");
			} else if (!this.tokenExpiration) {
				this.log.warn("Auth: Access token expiration unknown.");
			} else {
				this.log.warn(`Auth: Access token expired or nearing expiration (Expires: ${new Date(this.tokenExpiration).toISOString()}, Now: ${new Date(now).toISOString()}). Attempting refresh...`);
			}
			try {
				await this.refreshAccessToken();
			} catch (error) {
				this.log.error("Auth: Failed to refresh token during 'ensureAccessToken'. Attempting full login...", error);
				// If refresh fails (e.g., bad refresh token), try a full login
				await this.login();
			}
		} else {
			this.log.debug("Auth: Existing access token is still valid.");
		}
	}

	// Storage methods
	private async loadTokensFromStorage() {
		try {
			if (await fs.pathExists(this.tokensFilePath)) {
				const tokens: Partial<Tokens> = await fs.readJSON(this.tokensFilePath); // Use Partial<> for safety
				this.userIndex = typeof tokens.userIndex === 'number' ? tokens.userIndex : null;
				this.userId = typeof tokens.userId === 'string' ? tokens.userId : null;
				this.accessToken = typeof tokens.accessToken === 'string' ? tokens.accessToken : null;
				this.refreshToken = typeof tokens.refreshToken === 'string' ? tokens.refreshToken : null;
				this.tokenExpiration = typeof tokens.tokenExpiration === 'number' ? tokens.tokenExpiration : null;
				this.log.debug("Auth: Tokens successfully loaded from storage.");
			} else {
				this.log.debug("Auth: No tokens file found at:", this.tokensFilePath);
			}
		} catch (error) {
			this.log.error("Auth: Failed to load tokens from storage:", error);
			this.clearTokens(); // Clear potentially corrupted state
		}
	}

	private async saveTokensToStorage() {
		const tokensToSave: Tokens = {
			userIndex: this.userIndex,
			userId: this.userId,
			accessToken: this.accessToken,
			refreshToken: this.refreshToken,
			tokenExpiration: this.tokenExpiration,
		};
		try {
			await fs.writeJSON(this.tokensFilePath, tokensToSave, { spaces: 2 }); // Pretty print JSON
			this.log.debug("Auth: Tokens saved to storage at:", this.tokensFilePath);
		} catch (error) {
			this.log.error("Auth: Failed to save tokens to storage:", error);
		}
	}

	// Helper to clear all token/user info
	private clearTokens() {
		this.userIndex = null;
		this.userId = null;
		this.accessToken = null;
		this.refreshToken = null;
		this.tokenExpiration = null;
	}

	// end
}
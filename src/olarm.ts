import {Logger} from "homebridge";
import fetch from "node-fetch";
import {URLSearchParams} from "node:url";

export interface OlarmArea {
	areaName: string;
	deviceId: string;
	areaNumber: number;
	areaState: OlarmAreaState;
}

export enum OlarmAreaState {
	Armed = "arm",
	Disarmed = "disarm",
	ArmedStay = "stay",
	NotReady = "notready",
	Triggered = "activated",
	// ALARM_TRIGGERED
}

export enum OlarmAreaAction {
	Arm = "area-arm",
	Stay = "area-stay",
	Disarm = "area-disarm",
}

export class Olarm {
	private userEmailPhone: string;
	private userPass: string;
	private accessToken: string | null = null;
	private refreshToken: string | null = null;
	private tokenExpiration: number | null = null;
	private userIndex: number | null = null;

	private log: Logger;

	constructor({
								userEmailPhone,
								userPass,
								log,
							}: { userEmailPhone: string; userPass: string; log: Logger }) {
		this.userEmailPhone = userEmailPhone;
		this.userPass = userPass;
		this.log = log;
	}

	// Get all the available areas we have
	getAreas = async (): Promise<OlarmArea[]> => {
		await this.ensureAccessToken();

		if (!this.userIndex) {
			await this.fetchUserIndex();
		}

		this.log.debug("Fetching areas from Olarm API");
		const response = await fetch(
			`https://api-legacy.olarm.com/api/v2/users/${this.userIndex}`,
			{
				method: "GET",
				headers: {Authorization: `Bearer ${this.accessToken}`},
			},
		);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Failed to fetch devices: ${response.status} ${response.statusText} - ${errorText}`,
			);
		}

		const payload = await response.json();
		this.log.info(payload);

		const olarmAreas: OlarmArea[] = [];

		for (const device of payload.devices) {
			for (const [i, l] of device.profile.areasLabels.entries()) {
				olarmAreas.push({
					areaName: l,
					areaState: device.state.areas[i],
					areaNumber: i + 1,
					deviceId: device.id,
				});
			}
		}

		return olarmAreas;
	};

	setArea = async (area: OlarmArea, action: OlarmAreaAction) => {
		await this.ensureAccessToken();

		const response = await fetch(
			`https://api.olarm.com/api/v4/devices/${area.deviceId}/actions`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					actionCmd: action,
					actionNum: area.areaNumber,
				}),
			},
		);
		const result = await response.text();
		this.log.info("Response:", result);
	};

	// first time round we login to our user credentials supplied.
	private async login() {
		const response = await fetch(
			"https://auth.olarm.com/api/v4/oauth/login/mobile",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					userEmailPhone: this.userEmailPhone,
					userPass: this.userPass,
				}).toString(),
			},
		);

		if (!response.ok) {
			throw new Error("Login failed");
		}

		const data = await response.json();
		this.accessToken = data.oat;
		this.refreshToken = data.ort;
		this.tokenExpiration = data.oatExpire;
	}

	// util func to refresh our token everytime we fetch our deivces
	private async refreshAccessToken() {
		if (!this.refreshToken) {
			await this.login();
			return;
		}

		const response = await fetch(
			"https://auth.olarm.com/api/v4/oauth/refresh",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					ort: this.refreshToken,
				}).toString(),
			},
		);

		if (!response.ok) {
			throw new Error("Token refresh failed");
		}

		const data = await response.json();
		this.log.debug("Refreshed our Token");
		this.accessToken = data.oat;
		this.refreshToken = data.ort;
		this.tokenExpiration = data.oatExpire;
	}

	private async ensureAccessToken() {
		if (!this.accessToken || Date.now() >= this.tokenExpiration!) {
			if (this.refreshToken) {
				await this.refreshAccessToken();
			} else {
				await this.login();
			}
		}
	}

	// we need to get our user index so that we can request deivces data for that users.
	private async fetchUserIndex() {
		await this.ensureAccessToken();

		const url = `https://auth.olarm.com/api/v4/oauth/federated-link-existing?oat=${this.accessToken}`;

		const formData = new URLSearchParams({
			userEmailPhone: this.userEmailPhone,
			userPass: this.userPass,
			captchaToken: "olarmapp",
		});

		const response = await fetch(url, {
			method: "POST",
			headers: {"Content-Type": "application/x-www-form-urlencoded"},
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
}

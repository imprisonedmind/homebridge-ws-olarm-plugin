import { Logger } from "homebridge";
import {
	AlarmPayload,
	OlarmArea,
	OlarmAreaAction,
	OlarmAreaState,
} from "./types"; // Import types from a shared file
import { Auth, Device } from "./auth";
import { MqttClient } from "mqtt";

interface olarmProps {
	auth: Auth;
	log: Logger;
	mqttClients: Map<string, MqttClient>;
}

export class Olarm {
	private log: Logger;
	private auth: Auth;
	private areas: OlarmArea[] = [];
	private devicesMap: Map<string, Device> = new Map();
	private mqttClients: Map<string, MqttClient>;

	constructor({ auth, log, mqttClients }: olarmProps) {
		this.auth = auth;
		this.log = log;
		this.mqttClients = mqttClients;

		// Initialize devices map
		const devices = this.auth.getDevices();
		devices.forEach((device) => {
			this.devicesMap.set(device.id, device);
		});
	}

	// Method to process MQTT messages
	public processMqttMessage(
		deviceId: string,
		topic: string,
		message: string
	) {
		try {
			const payload: AlarmPayload = JSON.parse(message);
			if (payload.type === "alarmPayload") {
				this.log.debug("Processing MQTT alarm payload");
				this.parseAreasFromPayload(deviceId, payload);
			} else {
				this.log.debug("Received non-alarm MQTT message");
			}
		} catch (error) {
			this.log.error("Failed to parse MQTT message:", error);
		}
	}

	// Parse the areas from the MQTT payload
	private parseAreasFromPayload(deviceId: string, payload: AlarmPayload) {
		const newAreas: OlarmArea[] = [];
		const areasStates = payload.data.areas; // E.g., ["disarm"]
		const areasDetails = payload.data.areasDetail;

		for (let i = 0; i < areasStates.length; i++) {
			const areaName = areasDetails[i] || `Area ${i + 1}`;
			const areaState = areasStates[i]; // E.g., "disarm"

			newAreas.push({
				areaName: areaName,
				deviceId: deviceId, // Include deviceId here
				areaNumber: i + 1,
				areaState: this.convertAreaState(areaState),
			});
		}

		this.areas = newAreas; // Update the internal areas state
		this.log.debug("Updated areas:", this.areas);
	}

	// Convert area state from string to OlarmAreaState enum
	private convertAreaState(state: string): OlarmAreaState {
		switch (state) {
			case "arm":
				return OlarmAreaState.Armed;
			case "disarm":
				return OlarmAreaState.Disarmed;
			case "stay":
				return OlarmAreaState.ArmedStay;
			case "sleep":
				return OlarmAreaState.ArmedSleep;
			case "notready":
				return OlarmAreaState.NotReady;
			case "activated":
				return OlarmAreaState.Triggered;
			default:
				this.log.warn(`Unknown area state received: ${state}`);
				return OlarmAreaState.NotReady;
		}
	}

	// Method to get areas (called by discoverDevices)
	public getAreas(): OlarmArea[] {
		return this.areas;
	}

	// Method to handle area actions
	public async setArea(area: OlarmArea, action: OlarmAreaAction) {
		// Retrieve the MQTT client for the device
		const mqttClient = this.mqttClients.get(area.deviceId);
		if (!mqttClient) {
			this.log.error(`No MQTT client found for deviceId ${area.deviceId}`);
			return;
		}

		// Get the device object to retrieve IMEI
		const device = this.devicesMap.get(area.deviceId);
		if (!device) {
			this.log.error(`Device not found for deviceId ${area.deviceId}`);
			return;
		}

		// Construct the topic
		const topic = `si/app/v2/${device.IMEI}/control`;

		// Construct the payload
		const payload = {
			method: "POST",
			// TODO: these values are not enforced
			// userIndex: userIndex.toString(),
			// userId: userId,
			// access_token: "", // Leave empty if required
			data: [action, area.areaNumber],
		};

		const message = JSON.stringify(payload);

		this.log.debug(`Publishing to topic ${topic}: ${message}`);

		// Publish the action message
		mqttClient.publish(topic, message, { qos: 1 }, (error) => {
			if (error) {
				this.log.error(`Failed to publish to topic ${topic}:`, error);
			} else {
				this.log.info(`Published action to topic ${topic}`);
			}
		});
	}
}

import { Logger } from "homebridge";
import {
	AlarmPayload,
	OlarmArea,
	OlarmAreaAction,
	OlarmAreaState,
} from "./types"; // Import types from a shared file
import { Auth, Device } from "./auth";
import { MqttClient } from "mqtt";

// Define the expected properties for the Olarm constructor
interface olarmProps {
	auth: Auth;
	log: Logger;
	mqttClients: Map<string, MqttClient>;
	onStateUpdate: () => void; // Add the missing property definition
}

export class Olarm {
	private log: Logger;
	private auth: Auth;
	private areas: OlarmArea[] = [];
	private devicesMap: Map<string, Device> = new Map();
	private mqttClients: Map<string, MqttClient>;
	private onStateUpdateCallback: () => void; // Store the callback

	constructor({ auth, log, mqttClients, onStateUpdate }: olarmProps) {
		this.auth = auth;
		this.log = log;
		this.mqttClients = mqttClients;
		this.onStateUpdateCallback = onStateUpdate; // Store the passed callback

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
			// Attempt to parse the message as JSON
			let payload: any;
			try {
				payload = JSON.parse(message);
			} catch (e) {
				this.log.debug(`Received non-JSON message on topic ${topic}: ${message.substring(0,100)}...`);
				// Ignore non-JSON messages or handle specific plain text messages if needed
				return;
			}

			// Check if it's the expected alarm payload structure
			if (payload && payload.type === "alarmPayload" && payload.data && payload.data.areas) {
				this.log.debug(`Processing MQTT alarm payload for device ${deviceId}`);
				const stateChanged = this.parseAreasFromPayload(deviceId, payload as AlarmPayload);
				// If the state actually changed, invoke the callback
				if (stateChanged) {
					this.log.debug("Area state changed, triggering update callback.");
					this.onStateUpdateCallback();
				}
			} else {
				this.log.debug(`Received known JSON message type "${payload?.type || 'unknown'}", but not an alarmPayload with area data.`);
			}
		} catch (error) {
			this.log.error(`Failed to process MQTT message from topic ${topic}:`, error);
			this.log.error(`Original message: ${message.substring(0, 200)}...`);
		}
	}

	// Parse the areas from the MQTT payload and return true if state changed
	private parseAreasFromPayload(deviceId: string, payload: AlarmPayload): boolean {
		const newAreas: OlarmArea[] = [];
		let stateChanged = false;
		const areasStates = payload.data.areas; // E.g., ["disarm"]
		// Use areasDetail if available and has same length, otherwise generate names
		const areasDetails = (payload.data.areasDetail && payload.data.areasDetail.length === areasStates.length)
			? payload.data.areasDetail
			: areasStates.map((_, i) => `Area ${i + 1}`); // Generate names if details are missing/mismatched

		for (let i = 0; i < areasStates.length; i++) {
			const areaName = areasDetails[i];
			const areaStateStr = areasStates[i]; // E.g., "disarm"
			const areaStateEnum = this.convertAreaState(areaStateStr);

			const newArea: OlarmArea = {
				areaName: areaName,
				deviceId: deviceId,
				areaNumber: i + 1,
				areaState: areaStateEnum,
			};
			newAreas.push(newArea);

			// Check if this area's state changed compared to the previous state
			const existingArea = this.areas.find(a => a.deviceId === deviceId && a.areaNumber === (i + 1));
			if (!existingArea || existingArea.areaState !== newArea.areaState || existingArea.areaName !== newArea.areaName) {
				stateChanged = true;
			}
		}

		// Check if the number of areas changed
		if (this.areas.filter(a => a.deviceId === deviceId).length !== newAreas.length) {
			stateChanged = true;
		}

		// Update the internal areas state for the specific device
		// Remove old areas for this device first
		this.areas = this.areas.filter(a => a.deviceId !== deviceId);
		// Add the new areas for this device
		this.areas.push(...newAreas);

		if(stateChanged) {
			this.log.debug(`Updated areas for device ${deviceId}:`, newAreas);
		} else {
			this.log.debug(`Area state for device ${deviceId} unchanged.`);
		}

		return stateChanged; // Return whether any state relevant to accessories changed
	}

	// Convert area state from string to OlarmAreaState enum
	private convertAreaState(state: string): OlarmAreaState {
		state = state.toLowerCase(); // Normalize to lower case
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
			case "not ready": // Handle potential space
				return OlarmAreaState.NotReady;
			case "activated":
			case "alarm": // Handle potential "alarm" state string
				return OlarmAreaState.Triggered;
			default:
				this.log.warn(`Unknown area state received: "${state}". Mapping to NotReady.`);
				return OlarmAreaState.NotReady; // Default to a safe state
		}
	}

	// Method to get all areas (called by discoverDevices and state update handler)
	public getAreas(): OlarmArea[] {
		// Return a copy to prevent external modification
		return JSON.parse(JSON.stringify(this.areas));
	}

	// Method to handle area actions
	public async setArea(area: OlarmArea, action: OlarmAreaAction): Promise<boolean> {
		// Retrieve the MQTT client for the device
		const mqttClient = this.mqttClients.get(area.deviceId);
		if (!mqttClient || !mqttClient.connected) {
			this.log.error(`Cannot set area: MQTT client not found or not connected for deviceId ${area.deviceId}`);
			return false;
		}

		// Get the device object to retrieve IMEI
		const device = this.devicesMap.get(area.deviceId);
		if (!device) {
			this.log.error(`Cannot set area: Device details not found for deviceId ${area.deviceId}`);
			return false;
		}

		// Construct the topic
		const topic = `si/app/v2/${device.IMEI}/control`;

		// Construct the payload
		const payload = {
			method: "POST",
			// userIndex and userId might be needed by Olarm's backend, include if necessary
			// userIndex: this.auth.getUserIndex()?.toString(),
			// userId: this.auth.getUserId(),
			data: [
				action, // e.g., "arm", "disarm", "stay", "sleep"
				area.areaNumber // The number of the area (e.g., 1, 2)
			],
		};

		const message = JSON.stringify(payload);

		this.log.info(`Publishing action "${action}" for area ${area.areaNumber} (${area.areaName}) on device ${device.IMEI} to topic ${topic}`);
		this.log.debug(`Publish payload: ${message}`);

		// Publish the action message with QoS 1
		return new Promise((resolve) => {
			mqttClient.publish(topic, message, { qos: 1, retain: false }, (error) => {
				if (error) {
					this.log.error(`Failed to publish action to topic ${topic}:`, error);
					resolve(false);
				} else {
					this.log.info(`Successfully published action "${action}" for area ${area.areaName}. Waiting for state confirmation via MQTT...`);
					// Optimistically update internal state? No, wait for confirmation message.
					resolve(true);
				}
			});
		});
	}
}
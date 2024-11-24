import type {
	API,
	Characteristic,
	DynamicPlatformPlugin,
	Logger,
	PlatformAccessory,
	PlatformConfig,
	Service,
} from "homebridge";

import {PLATFORM_NAME, PLUGIN_NAME} from "./settings";
import {OlarmAreaPlatformAccessory} from "./platformAccessory";
import {Olarm} from "./olarm";
import mqtt, {MqttClient} from 'mqtt';
import {Auth, Device} from "./auth";

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class OlarmHomebridgePlatform implements DynamicPlatformPlugin {
	public readonly Service: typeof Service = this.api.hap.Service;
	public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

	public olarm: Olarm | undefined;
	private auth: Auth | undefined;
	private mqttClients: Map<string, MqttClient> = new Map();

	// this is used to track restored cached accessories
	public readonly accessories: PlatformAccessory[] = [];

	constructor(
		public readonly log: Logger,
		public readonly config: PlatformConfig,
		public readonly api: API,
	) {
		this.log.debug("Finished initializing platform:", this.config.name);

		// When this event is fired it means Homebridge has restored all cached accessories from disk.
		// Dynamic Platform plugins should only register new accessories after this event was fired,
		// in order to ensure they weren't added to homebridge already. This event can also be used
		// to start discovery of new accessories.
		this.api.on("didFinishLaunching", () => {
			this.initializePlugin()
		});
	}

	private async initializePlugin() {
		try {
			this.log.debug('Storage initialized');

			// Initialize Auth
			this.auth = new Auth({
				userEmailPhone: this.config.userEmailPhone,
				userPass: this.config.userPass,
				log: this.log,
			});

			await this.auth.initialize();

			// Initialize Olarm
			this.olarm = new Olarm({
				auth: this.auth,
				log: this.log,
				mqttClients: this.mqttClients,
			});

			// Initialize MQTT and Discover Devices
			await this.initializeOlarmAndMQTT();
		} catch (error) {
			this.log.error('Initialization error:', error);
		}
	}

	private async initializeOlarmAndMQTT() {
		// Use devices from Auth instance
		const devices = this.auth!.getDevices();

		if (!devices || devices.length === 0) {
			this.log.error('No devices found for this user.');
			return;
		}

		// Initialize MQTT for each device
		for (const device of devices) {
			await this.initializeMQTTForDevice(device);
		}
	}

	private async initializeMQTTForDevice(device: Device) {
		// MQTT Connection Options
		const tokens = this.auth!.getTokens();
		if (!tokens.accessToken) {
			this.log.error('No access token available for MQTT connection');
			return;
		}

		const mqttOptions: mqtt.IClientOptions = {
			host: 'mqtt-ws.olarm.com',
			port: 443,
			username: 'native_app',
			protocol: 'wss',
			password: tokens.accessToken,
			clientId: `native-app-oauth-${device.IMEI}`,
		};

		this.log.debug('MQTT Options:', mqttOptions);

		const mqttClient = mqtt.connect(mqttOptions);

		mqttClient.on('message', (topic, message) => {
			this.log.info('[MQTT] Message received', topic);
			// Pass device.id to processMqttMessage
			this.olarm!.processMqttMessage(device.id, topic, message.toString());
			// After processing the message, update devices
			this.discoverDevices();
		});

		mqttClient.on('connect', () => {
			this.log.info('[MQTT] Connected');

			// Subscribe to the topic to receive messages from the device
			const subTopic = `so/app/v1/${device.IMEI}`;
			mqttClient.subscribe(subTopic, (err) => {
				if (err) {
					this.log.error(`Failed to subscribe to topic: ${err}`);
				} else {
					this.log.info(`Subscribed to topic: ${subTopic}`);

					// Publish the initial GET message to prompt device status
					const statusTopic = `si/app/v2/${device.IMEI}/status`;
					const message = JSON.stringify({ method: "GET" });

					mqttClient.publish(statusTopic, message, { qos: 1 }, (error) => {
						if (error) {
							this.log.error(`Failed to publish to topic ${statusTopic}:`, error);
						} else {
							this.log.info(`Published GET request to topic ${statusTopic}`);
						}
					});
				}
			});
		});

		mqttClient.on('error', (error) => {
			this.log.error('MQTT Client Error:', error);
		});

		// Store the mqttClient
		this.mqttClients.set(device.id, mqttClient);
	}


	/**
	 * This function is invoked when homebridge restores cached accessories from disk at startup.
	 * It should be used to setup event handlers for characteristics and update respective values.
	 */
	configureAccessory(accessory: PlatformAccessory) {
		this.log.info("Loading accessory from cache:", accessory.displayName);

		// add the restored accessory to the accessories cache so we can track if it has already been registered
		this.accessories.push(accessory);
	}

	/**
	 * This is an example method showing how to register discovered accessories.
	 * Accessories must only be registered once, previously created accessories
	 * must not be registered again to prevent "duplicate UUID" errors.
	 */
	async discoverDevices() {
		const olarmAreas = this.olarm!.getAreas();

		this.log.info(
			`Retrieved areas from Olarm: ${olarmAreas.map((a) => a.areaName).join(", ")}`,
		);

		let accessoryUUIDsToUnregister = this.accessories.map((a) => a.UUID);

		// loop over the discovered devices and register each one if it has not already been registered
		for (const area of olarmAreas) {
			console.log(area);
			// Generate a unique id for the area
			const uuid = this.api.hap.uuid.generate(area.deviceId + area.areaNumber);

			// see if an accessory with the same uuid has already been registered and restored from
			// the cached devices we stored in the `configureAccessory` method above
			const existingAccessory = this.accessories.find(
				(accessory) => accessory.UUID === uuid,
			);

			if (existingAccessory) {
				// Remove this accessory from the list of items to remove
				accessoryUUIDsToUnregister = accessoryUUIDsToUnregister.filter(
					(u) => u !== uuid,
				);

				// the accessory already exists
				this.log.info(
					"Restoring existing accessory from cache:",
					existingAccessory.displayName,
				);

				// if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
				existingAccessory.context.area = area;
				this.api.updatePlatformAccessories([existingAccessory]);

				// create the accessory handler for the restored accessory
				// this is imported from `platformAccessory.ts`
				new OlarmAreaPlatformAccessory(this, existingAccessory);
			} else {
				// the accessory does not yet exist, so we need to create it
				this.log.info("Adding new accessory:", area.areaName);

				// create a new accessory
				const accessory = new this.api.platformAccessory(
					area.areaName || "no area name",
					uuid,
				);

				// store a copy of the device object in the `accessory.context`
				// the `context` property can be used to store any data about the accessory you may need
				accessory.context.area = area;

				// create the accessory handler for the newly create accessory
				// this is imported from `platformAccessory.ts`
				new OlarmAreaPlatformAccessory(this, accessory);

				// link the accessory to your platform
				this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
					accessory,
				]);
			}
		}

		if (accessoryUUIDsToUnregister.length > 0) {
			this.log.info(
				`Some accessories need to be unregistered (${accessoryUUIDsToUnregister.length})`,
			);
			for (const uuid of accessoryUUIDsToUnregister) {
				const accessoryToUnregister = this.accessories.find(
					(accessory) => accessory.UUID === uuid,
				);
				if (accessoryToUnregister) {
					// it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`,
					//  eg. remove platform accessories when no longer present
					this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
						accessoryToUnregister,
					]);
					this.log.info(
						"Removing existing accessory from cache:",
						accessoryToUnregister.displayName,
					);
				} else {
					this.log.info("WARNING: could not find accessory with UUID", uuid);
				}
			}
		}
	}

}

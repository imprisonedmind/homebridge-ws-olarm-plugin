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

import * as path from "path";
import storage from 'node-persist';
import mqtt, {MqttClient} from 'mqtt';
import {Auth} from "./auth";

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class OlarmHomebridgePlatform implements DynamicPlatformPlugin {
	public readonly Service: typeof Service = this.api.hap.Service;
	public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

	public olarm: Olarm | undefined;
	public mqttClient: MqttClient | undefined;
	private auth: Auth | undefined;
	private readonly storage: storage.LocalStorage;

	// this is used to track restored cached accessories
	public readonly accessories: PlatformAccessory[] = [];

	constructor(
		public readonly log: Logger,
		public readonly config: PlatformConfig,
		public readonly api: API,
	) {
		this.log.debug("Finished initializing platform:", this.config.name);

		// Initialize node-persist storage
		this.storage = storage.create({
			dir: path.join(this.api.user.persistPath(), PLATFORM_NAME),
		});

		this.storage.init().then(() => {
			this.log.debug('Storage initialized');

			// Initialize Auth
			this.auth = new Auth({
				userEmailPhone: this.config.userEmailPhone,
				userPass: this.config.userPass,
				storage: this.storage,
				log: this.log,
			});

			this.auth.initialize().then(() => {
				this.initializeOlarmAndMQTT();
			});
		});
	}


	private async initializeOlarmAndMQTT() {
		// Initialize Olarm
		this.olarm = new Olarm({auth: this.auth!, log: this.log});

		// Get tokens for MQTT
		const tokens = this.auth!.getTokens();
		if (!tokens.accessToken) {
			this.log.error('No access token available for MQTT connection');
			return;
		}

		// MQTT Connection Options
		const mqttOptions: mqtt.IClientOptions = {
			// "mqtt-ws.olarm.com"
			host: this.config.mqttHost,
			port: 443,
			username: 'native_app',
			protocol: 'wss',
			// password = accessToken
			password: tokens.accessToken,
			clientId: `native-app-oauth-${this.config.imei}`, // unique client ID
		};

		this.log.debug('MQTT Options:', mqttOptions);
		this.mqttClient = mqtt.connect(mqttOptions);

		this.mqttClient.on('message', (topic, message) => {
			this.log.info('[MQTT] General <-', topic);
		});

		this.mqttClient.on('connect', () => {
			this.log.info('[MQTT] Connected', this.config.ssc);
			const subTopic = `so/app/v1/867556040470604`;
			this.mqttClient?.subscribe(subTopic, (err) => {
				if (err) {
					this.log.error(`Failed to subscribe to topic: ${err}`);
				} else {
					this.log.info(`Subscribed to topic: ${subTopic}`);
					// When this event is fired it means Homebridge has restored all cached accessories from disk.
					// Dynamic Platform plugins should only register new accessories after this event was fired,
					// in order to ensure they weren't added to homebridge already. This event can also be used
					// to start discovery of new accessories.
					this.api.on("didFinishLaunching", () => {
						this.discoverDevices();
					});
				}
			});
		});

		this.mqttClient.on('error', (error) => {
			this.log.error('MQTT Client Error:', error);
		});
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
		const olarmAreas = await this.olarm!.getAreas();

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

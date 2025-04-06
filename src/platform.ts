import type {
	API,
	Characteristic,
	DynamicPlatformPlugin,
	Logger,
	PlatformAccessory,
	PlatformConfig,
	Service,
} from "homebridge";

import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { OlarmAreaPlatformAccessory } from "./platformAccessory";
import { Olarm } from "./olarm";
import mqtt, { MqttClient, IClientOptions } from "mqtt";
import { Auth, Device } from "./auth";
import { OlarmArea, OlarmAreaState } from "./types"; // Import OlarmAreaState

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class OlarmHomebridgePlatform implements DynamicPlatformPlugin {
	public readonly Service: typeof Service = this.api.hap.Service;
	public readonly Characteristic: typeof Characteristic =
		this.api.hap.Characteristic;

	public olarm: Olarm | undefined;
	private auth: Auth | undefined;
	private mqttClients: Map<string, MqttClient> = new Map();

	// this is used to track restored cached accessories
	public readonly accessories: PlatformAccessory[] = [];
	// Map to hold accessory handlers, keyed by accessory UUID
	private readonly accessoryHandlers: Map<string, OlarmAreaPlatformAccessory> = new Map();
	private initialDeviceDiscoveryDone = false; // Flag to prevent multiple discoveries on message flood


	constructor(
		public readonly log: Logger,
		public readonly config: PlatformConfig,
		public readonly api: API
	) {
		this.log.debug("Finished initializing platform:", this.config.name);

		// Register cleanup on shutdown
		this.api.on('shutdown', this.shutdown.bind(this));

		// When this event is fired it means Homebridge has restored all cached accessories from disk.
		// Dynamic Platform plugins should only register new accessories after this event was fired,
		// in order to ensure they weren't added to homebridge already. This event can also be used
		// to start discovery of new accessories.
		this.api.on("didFinishLaunching", () => {
			this.log.info("Homebridge Finished Launching");
			this.initializePlugin().catch((error) => {
				this.log.error("Failed to initialize plugin:", error);
			});
		});
	}

	private async initializePlugin() {
		try {
			this.log.info("Initializing Olarm Plugin...");

			// Initialize Auth
			this.auth = new Auth({
				userEmailPhone: this.config.userEmailPhone,
				userPass: this.config.userPass,
				log: this.log,
			});

			this.log.info("Initializing Authentication...");
			await this.auth.initialize();
			this.log.info("Authentication successful.");

			// Initialize Olarm service wrapper
			this.olarm = new Olarm({
				auth: this.auth,
				log: this.log,
				mqttClients: this.mqttClients,
				// Pass a callback to trigger accessory updates when state changes
				onStateUpdate: () => this.updateAccessoryStates(),
			});

			// Initialize MQTT and wait for connections before discovering devices
			await this.initializeOlarmAndMQTT();

			// Initial discovery after MQTT setup
			this.log.info("Performing initial device discovery...");
			this.discoverDevices();
			this.initialDeviceDiscoveryDone = true; // Mark initial discovery attempt as done

		} catch (error) {
			this.log.error("Initialization error:", error);
			if (error instanceof Error) {
				this.log.error("Error Details:", error.message, error.stack);
			}
		}
	}

	private async initializeOlarmAndMQTT() {
		// Use devices from Auth instance
		const devices = this.auth!.getDevices();

		if (!devices || devices.length === 0) {
			this.log.error("No devices found for this user.");
			return;
		}

		this.log.info(`Found ${devices.length} device(s). Initializing MQTT...`);

		const connectionPromises = devices.map(device => this.initializeMQTTForDevice(device));

		try {
			await Promise.all(connectionPromises);
			this.log.info("MQTT initialization completed for all devices.");
		} catch (error) {
			this.log.error("Error during MQTT initialization for one or more devices:", error);
			// Decide if partial functionality is acceptable or if we should stop
		}
	}

	private initializeMQTTForDevice(device: Device): Promise<void> {
		return new Promise((resolve, reject) => {
			this.log.info(`Initializing MQTT for device: ${device.IMEI} (ID: ${device.id})`);
			// MQTT Connection Options
			const tokens = this.auth!.getTokens();
			if (!tokens.accessToken) {
				this.log.error(`No access token available for MQTT connection for device ${device.IMEI}`);
				return reject(new Error(`No access token for device ${device.IMEI}`));
			}

			const clientId = `native-app-oauth-${device.IMEI}`;
			const mqttOptions: IClientOptions = {
				host: "mqtt-ws.olarm.com",
				port: 443,
				username: "native_app",
				protocol: "wss",
				password: tokens.accessToken,
				clientId: clientId,
				protocolVersion: 4,
				keepalive: 60,
				reconnectPeriod: 1000 * 5,
				connectTimeout: 1000 * 10,
				clean: true,
			};

			this.log.debug(`[MQTT ${device.IMEI}] Options:`, { ...mqttOptions, password: '***' });

			// --- Check for existing client ---
			let existingClient = this.mqttClients.get(device.id);
			if (existingClient) {
				if (existingClient.connected) {
					this.log.info(`[MQTT ${device.IMEI}] Client already connected.`);
					resolve(); // Already connected, nothing more to do for this attempt
					return;
				} else {
					// Client exists but is not connected (e.g., closed, reconnecting failed)
					this.log.warn(`[MQTT ${device.IMEI}] Existing client found but not connected. Ending it before creating a new one.`);
					existingClient.end(true); // Force close the old client
					this.mqttClients.delete(device.id); // Remove from map
				}
			}
			// --- End check for existing client ---


			// --- Create and connect new client ---
			const mqttClient = mqtt.connect(mqttOptions);

			// Store the new client immediately
			this.mqttClients.set(device.id, mqttClient);


			// --- Event Handlers ---

			// Handler for successful initial connection
			const onConnect = (connack: mqtt.IConnackPacket) => {
				this.log.info(`[MQTT ${device.IMEI}] Connected (ClientId: ${clientId}). Connack:`, connack);
				mqttClient.removeListener('error', onInitialError); // Remove initial error handler

				// Setup persistent error handler
				mqttClient.on('error', onPersistentError);

				// Subscribe to the topic
				const subTopic = `so/app/v1/${device.IMEI}`;
				mqttClient.subscribe(subTopic, { qos: 1 }, (err, granted) => {
					if (err) {
						this.log.error(`[MQTT ${device.IMEI}] Failed to subscribe to topic ${subTopic}:`, err);
						mqttClient.end(true);
						this.mqttClients.delete(device.id);
						// Since connection was initially successful, we resolve, but log error.
						// Or potentially reject here if subscription is critical? Let's resolve for now.
						resolve();
					} else {
						this.log.info(`[MQTT ${device.IMEI}] Subscribed to topic: ${subTopic}. Granted:`, granted);
						publishInitialGet(); // Publish GET after successful subscription
						resolve(); // Resolve the promise once connected and subscribed
					}
				});
			};

			// Handler for error during initial connection attempt
			const onInitialError = (error: Error) => {
				this.log.error(`[MQTT ${device.IMEI}] Initial Connection Error (ClientId: ${clientId}):`, error);
				if ((error as any).code === 5) {
					this.log.error(`[MQTT ${device.IMEI}] Connection refused (Code 5) - Check ClientID, Username, Password/Token, Protocol.`);
				}
				mqttClient.end(true); // Ensure client is closed
				this.mqttClients.delete(device.id); // Clean up map
				reject(error); // Reject promise on initial connection error
			};

			// Handler for errors *after* successful connection
			const onPersistentError = (error: Error) => {
				this.log.error(`[MQTT ${device.IMEI}] Persistent Client Error (ClientId: ${clientId}):`, error);
				// Log only, rely on reconnectPeriod or manual intervention
			};

			// Function to publish the initial GET request
			const publishInitialGet = () => {
				const statusTopic = `si/app/v2/${device.IMEI}/status`;
				const message = JSON.stringify({ method: "GET" });
				mqttClient.publish(statusTopic, message, { qos: 1, retain: false }, (error) => {
					if (error) {
						this.log.error(`[MQTT ${device.IMEI}] Failed to publish GET request to topic ${statusTopic}:`, error);
					} else {
						this.log.info(`[MQTT ${device.IMEI}] Published GET request to topic ${statusTopic}`);
					}
				});
			};

			// Attach initial handlers
			mqttClient.once('connect', onConnect);
			mqttClient.once('error', onInitialError); // Catches errors during the connect() call itself

			// Attach persistent handlers
			mqttClient.on('message', (topic, message) => {
				const messageString = message.toString();
				this.log.debug(`[MQTT ${device.IMEI}] Message received on topic ${topic}: ${messageString.substring(0, 100)}...`);
				try {
					this.olarm!.processMqttMessage(device.id, topic, messageString);
				} catch (parseError) {
					this.log.error(`[MQTT ${device.IMEI}] Error processing message on topic ${topic}:`, parseError);
				}
			});

			mqttClient.on('reconnect', () => {
				this.log.info(`[MQTT ${device.IMEI}] Attempting to reconnect...`);
			});

			mqttClient.on('offline', () => {
				this.log.warn(`[MQTT ${device.IMEI}] Client is offline.`);
			});

			mqttClient.on('close', () => {
				this.log.info(`[MQTT ${device.IMEI}] Connection closed.`);
				// Optionally remove from map if not relying on auto-reconnect,
				// but given reconnectPeriod is set, it's likely better to leave it.
			});

		});
	}

	/**
	 * This function is invoked when homebridge restores cached accessories from disk at startup.
	 * It should be used to setup event handlers for characteristics and update respective values.
	 */
	configureAccessory(accessory: PlatformAccessory) {
		this.log.info(`Loading accessory from cache: ${accessory.displayName} (UUID: ${accessory.UUID})`);

		// Add the restored accessory to the accessories cache so we can track if it has already been registered
		this.accessories.push(accessory);

		// Re-create the handler for the cached accessory upon loading
		// The context *should* contain the necessary 'area' info from the last known state
		if (accessory.context.area) {
			this.log.debug(`Re-creating handler for cached accessory ${accessory.displayName}`);
			const handler = new OlarmAreaPlatformAccessory(this, accessory);
			this.accessoryHandlers.set(accessory.UUID, handler);
		} else {
			this.log.warn(`Cached accessory ${accessory.displayName} is missing 'area' context. Handler not created. It might be removed if not rediscovered.`);
		}
	}

	/**
	 * This method registers discovered accessories.
	 * Accessories must only be registered once; previously created accessories
	 * must not be registered again to prevent "duplicate UUID" errors.
	 */
	discoverDevices() {
		if (!this.olarm) {
			this.log.warn("Olarm service not initialized. Skipping device discovery.");
			return;
		}

		const olarmAreas = this.olarm.getAreas(); // Get currently known areas

		if (olarmAreas.length === 0 && !this.initialDeviceDiscoveryDone) {
			this.log.debug("No areas reported by Olarm service yet. Waiting for initial state...");
		} else if (olarmAreas.length === 0 && this.initialDeviceDiscoveryDone) {
			this.log.warn("No areas reported by Olarm service. Check connection and device status.");
		} else {
			this.log.info(
				`Discovering devices based on ${olarmAreas.length} areas: ${olarmAreas
					.map((a) => `${a.areaName || 'Unnamed Area'} (${a.areaNumber} / ${a.deviceId.substring(0,6)}...)`)
					.join(", ")}`
			);
		}

		const currentAccessoryUUIDs = new Set<string>();

		// loop over the discovered areas and register each one if it has not already been registered
		for (const area of olarmAreas) {
			// Generate a unique id for the area based on device ID and area number
			const uuid = this.api.hap.uuid.generate(area.deviceId + area.areaNumber.toString());
			currentAccessoryUUIDs.add(uuid);

			// see if an accessory with the same uuid has already been registered and restored from cache
			const existingAccessory = this.accessories.find(
				(accessory) => accessory.UUID === uuid
			);

			if (existingAccessory) {
				// the accessory already exists
				this.log.info(
					`Restoring/Updating existing accessory: ${existingAccessory.displayName} (UUID: ${uuid})`
				);

				existingAccessory.context.area = area;
				this.api.updatePlatformAccessories([existingAccessory]); // Inform Homebridge of context change

				let handler = this.accessoryHandlers.get(uuid);
				if (!handler) {
					this.log.warn(`Handler missing for existing accessory ${existingAccessory.displayName}. Creating now.`);
					handler = new OlarmAreaPlatformAccessory(this, existingAccessory);
					this.accessoryHandlers.set(uuid, handler);
				}
				// Update the handler with the latest state just in case it missed an update
				handler.updateStateFromExternal(area.areaState);


			} else {
				// the accessory does not yet exist, so we need to create it
				const areaName = area.areaName || `Area ${area.areaNumber}`;
				this.log.info(`Adding new accessory: ${areaName} (UUID: ${uuid})`);

				const accessory = new this.api.platformAccessory(areaName, uuid);
				accessory.context.area = area;

				const handler = new OlarmAreaPlatformAccessory(this, accessory);
				this.accessoryHandlers.set(uuid, handler);

				this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
					accessory,
				]);
				this.accessories.push(accessory);
			}
		}

		// Unregister accessories that are no longer reported by the Olarm service
		const accessoriesToUnregister = this.accessories.filter(
			(acc) => !currentAccessoryUUIDs.has(acc.UUID)
		);

		if (accessoriesToUnregister.length > 0) {
			this.log.info(
				`Unregistering ${accessoriesToUnregister.length} obsolete accessories...`
			);
			const unregisteredAccessories: PlatformAccessory[] = [];
			accessoriesToUnregister.forEach(acc => {
				this.log.info(`Removing accessory: ${acc.displayName} (UUID: ${acc.UUID})`);
				unregisteredAccessories.push(acc);
				this.accessoryHandlers.delete(acc.UUID);
			});

			if (unregisteredAccessories.length > 0) {
				this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, unregisteredAccessories);
				const indicesToRemove = unregisteredAccessories.map(unregAcc =>
					this.accessories.findIndex(acc => acc.UUID === unregAcc.UUID)
				).filter(index => index > -1).sort((a, b) => b - a);
				indicesToRemove.forEach(index => this.accessories.splice(index, 1));
			}
		}
	}

	/**
	 * Called by Olarm service when state updates occur.
	 * This method should update the characteristics of relevant accessories.
	 */
	updateAccessoryStates() {
		this.log.debug("Received state update notification from Olarm service. Updating accessories...");

		if (!this.initialDeviceDiscoveryDone) {
			this.log.debug("Initial discovery not yet marked as complete, running discovery first.");
			this.discoverDevices();
			this.initialDeviceDiscoveryDone = true;
		}

		const olarmAreas = this.olarm?.getAreas() ?? [];

		for (const area of olarmAreas) {
			const uuid = this.api.hap.uuid.generate(area.deviceId + area.areaNumber.toString());
			const handler = this.accessoryHandlers.get(uuid);
			const accessory = this.accessories.find(acc => acc.UUID === uuid);

			if (handler && accessory) {
				this.log.debug(`Updating state for accessory via handler: ${accessory.displayName}`);
				accessory.context.area = area;
				handler.updateStateFromExternal(area.areaState);
			} else if (!handler && accessory) {
				this.log.warn(`Accessory found for update (${accessory.displayName}) but handler is missing in map. Re-running discovery.`);
				this.discoverDevices();
			} else if (!accessory) {
				this.log.warn(`Received state update for unknown accessory (UUID: ${uuid}, Area: ${area.areaName}). Triggering discovery.`);
				this.discoverDevices();
			}
		}
	}

	// Clean up MQTT connections on shutdown
	shutdown() {
		this.log.info("Shutting down Olarm platform...");
		this.mqttClients.forEach((client, deviceId) => {
			if (client) { // Check if client exists
				this.log.info(`Closing MQTT connection for device ID: ${deviceId}`);
				client.end(true, () => {
					this.log.info(`MQTT connection closed callback for device ID: ${deviceId}`);
				});
			}
		});
		this.mqttClients.clear();
		this.accessoryHandlers.clear();
		this.log.info("Olarm platform shutdown complete.");
	}
}
## Description
This plugin utilises WebSockets and [MQTT](https://github.com/mqttjs) to speak 
directly to an [Olarm](https://olarm.co) Communicator.
<br>
It's intent is to be used to control your alarm system via creating HomeKit and Google 
Home Interfaces with 
[homebridge](https://github.com/homebridge/homebridge).
<br><br>
I would thank [LouwHopley](https://github.com/LouwHopley), as his 
[repo](https://github.com/LouwHopley/homebridge-olarm-plugin) 
gave me a significant amount of work to stand upon.

___

### Installing
1. In your Homebridge directory, run `npm i homebridge-ws-olarm-plugin`
2. Set up the new platform in your Homebridge config.json
```
{
  "platform": "OlarmWSHomebridgePlugin",
  "name": "homebridge-ws-olarm-plugin",
  "userEmailPhone": "<your preffered login method>",
  "userPass": "<your password>"
}
```
3. Restart your Homebridge
___
### Usage

The plugin will automatically scan all devices on your Olarm account and pull in their areas. Each area will be created as a separate accessory.

Note that HomeKit forces 4 alarm states: `Home`, `Away`, `Night` and `Off` which as of writing can't be customised. Hence, the states have been mapped to the following:


| Apple | Olarm    |
|-------|----------|
| Away  | Armed    |
| Night | Sleep    |
| Home  | Stay     |
| Off   | Disarmed |


Triggered / alarm activated states are not yet connected.
___
### Development

Follow the below instructions if you want to fork and evolve this plugin.

_Note: YMMV with setup guides below_

1. Clone the repo onto your device that hosts your Homebridge instance.
2. Run `npm install` to install dependencies.
3. Run `npm run watch` to have `nodemon` run and keep it updated. It also runs `npm link`.

**Now to plug it into your Homebridge**

1. Run `npm run build` to build the plugin into `/dist` (`npm run watch` will do the same)
2. Run `pwd` to get the full path to the plugin (e.g.`./homebridge/olarm-ws-plugin`)
3. Inside Homebridge's directory, Run `npm link` if needed `sudo npm link <path from step 2>`
4. Update the Homebridge `config.json` with this platform:
```
{
  "platform": "OlarmWSHomebridgePlugin",
  "name": "homebridge-ws-olarm-plugin",
  "userEmailPhone": "<your preffered login method>",
}
```
4. Restart your Homebridge `sudo systemctl restart homebridge`



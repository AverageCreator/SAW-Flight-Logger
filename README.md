# SAW-Flight-Logger
The Half-Automated Webhook Flight Logger (SAW or JARVIS for the besties) is a GeoFS script that allows to pilots to log their flight via Webhook. This requires a shorter amount of time to log a flight.

How to install it?
Copy the main.js and paste it into tampermonkey
Hop in GeoFS
Do right click and inspect
Go to console
Paste the code

Setup completed for the script

How to make it work?

1. Create a webhook in your flight log channel and name it whatever you want
2. Copy the URL 
3. Press the "+add" green button and add your airline to the list, paste the url into the pop-up.
Setup completed for the webhook
*PS: The "default" is the link of our test server, don't forget to set and choose your own airline, if u make this mistake, dm seabus0316 to find your flight information. 

How to use it?

Just enter the flight no. (ex:516) into the UI, and press "start flight logger"
If the airport isn't in the database (https://github.com/seabus0316/GeoFS-METAR-system/raw/refs/heads/main/airports_with_tz.json), it will ask you for the airport's ICAO, which means you have to enter it manually, or it will show "unknown" in the flight report.
In your flight log channel, now you should see a bunch of flight logs messages sent by your webhook

Terms and conditions of the SAW system:
1. You agree not to fake flights with the script
2. You agree not to make any major changes without giving notice to the creator due to technical reasons
3. You agree to give pilots decent preparation for using the script

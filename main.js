// ==UserScript==
// @name         GeoFS Flight Logger 
// @namespace    https://your-va.org/flightlogger
// @version      2025-07-17
// @description  Logs flights for every airport by asking the pilot to enter ICAO codes manually
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const WEBHOOK_URL = "" //webhook URL here; 

  let flightStarted = false;
  let flightStartTime = null;
  let departureICAO = "UNKNOWN";
  let arrivalICAO = "UNKNOWN";
  let hasLanded = false;

  const pilotName = prompt("👨‍✈️ Enter your pilot name or callsign:") || "UnknownPilot";

  function sendLogToDiscord(data) {
    const aircraftType = prompt("🛩️ Enter your aircraft type (e.g., A320, B738, C172):") || "Unknown Aircraft";
    const now = new Date();
    const options = { timeZone: "Europe/London", day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
    const timestamp = new Intl.DateTimeFormat('en-GB', options).format(now);
    const takeoffTime = new Intl.DateTimeFormat('en-GB', options).format(new Date(data.takeoff));
    const landingTime = new Intl.DateTimeFormat('en-GB', options).format(new Date(data.landing));

    const message = {
      content: `🧾 **Flight Report - GeoFS**
**✈️Flight Number and operator**: ${data.pilot}
**🛩️ Aircraft**: ${aircraftType}
**📍Departure**: ${data.dep}
**🛬 Arrival**: ${data.arr}
**⏱️Flight Time**: ${data.duration} mins
**📉V/S**: ${data.vs} fpm | **G-Force**: ${data.gforce}
**⚙️TAS**: ${data.ktrue} kts | **GS**: ${data.gs} kts
**🏁Landing**: ${data.landingQuality}
**🕓 Takeoff Time**: ${takeoffTime} BST
**🕓 Landing Time**: ${landingTime} BST`
    };

    if (WEBHOOK_URL) {
      fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message)
      }).then(r => console.log("✅ Flight log sent"))
        .catch(console.error);
    } else {
      console.log("📋 Flight log:", message.content);
    }
  }

  function monitorFlight() {
    if (!geofs?.animation?.values || geofs.isPaused()) return;

    const values = geofs.animation.values;
    const onGround = values.groundContact;
    const altitude = values.altitude;

    // Start
    if (!flightStarted && !onGround && altitude > 200) {
      flightStarted = true;
      flightStartTime = Date.now();
      departureICAO = prompt("📍 Enter ICAO of departure airport:") || "UNKNOWN";
      console.log(`🛫 Departure: ${departureICAO}`);
    }

    // End
    if (flightStarted && onGround && !hasLanded && values.groundSpeedKnt < 1) {
      const confirmEnd = confirm("✈️ Aircraft has come to a full stop. Do you want to end the flight?");
      if (!confirmEnd) return;
      hasLanded = true;
      const durationMin = Math.round((Date.now() - flightStartTime) / 60000);
      arrivalICAO = prompt("📍 Enter ICAO of arrival airport:") || "UNKNOWN";
      const vs = values.verticalSpeed.toFixed(1);
      const g = (values.accZ / 9.80665).toFixed(2);
      const gs = values.groundSpeedKnt.toFixed(1);
      const tas = geofs.aircraft.instance.trueAirSpeed.toFixed(1);
      const quality = (vs > -60) ? "BUTTER" : (vs > -800) ? "HARD" : "CRASH";

      sendLogToDiscord({
        pilot: pilotName,
        takeoff: flightStartTime,
        landing: Date.now(),
        dep: departureICAO,
        arr: arrivalICAO,
        duration: durationMin,
        vs: vs,
        gforce: g,
        gs: gs,
        ktrue: tas,
        landingQuality: quality
      });

      // Reset
      setTimeout(() => {
        flightStarted = false;
        hasLanded = false;
        flightStartTime = null;
        departureICAO = "UNKNOWN";
        arrivalICAO = "UNKNOWN";
      }, 15000);
    }
  }

  console.log("✅ GeoFS Flight Logger (Manual ICAO Mode) Loaded");
  setInterval(monitorFlight, 1000);
})();

// ==UserScript==
// @name         Auto-Airport Flight Logger (GeoFS)
// @namespace    https://your-va.org/flightlogger
// @version      2025-09-06
// @description  Logs flights with crash detection, auto ICAO detection, session recovery & terrain-based AGL check
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const WEBHOOK_URL = "https://discord.com/api/webhooks/1406257491200966676/uo2BElGKf3Z2OTy2KGskd-cuIzKdiJSlgkiYUd9Hd0_622E0xE88Xigmqp4we6Woepxl";
  const STORAGE_KEY = "geofs_flight_logger_session";
  const AIRLINES_KEY = "geofs_flight_logger_airlines";
  const LAST_AIRLINE_KEY = "geofs_flight_logger_last_airline";
  const TERMS_AGREED_KEY = "geofs_flight_logger_terms_agreed";

  let flightStarted = false;
  let flightStartTime = null;
  let departureICAO = "UNKNOWN";
  let arrivalICAO = "UNKNOWN";
  let hasLanded = false;
  let monitorInterval = null;
  let firstGroundContact = false;
  let firstGroundTime = null;
  let panelUI, startButton, callsignInput, aircraftInput, airlineSelect;
  let airportsDB = [];
  let departureAirportData = null;
  let arrivalAirportData = null;

  // Enhanced landing stats variables - using terrain-calibrated calculation
  let oldAGL = 0;
  let newAGL = 0;
  let calculatedVerticalSpeed = 0;
  let oldTime = Date.now();
  let newTime = Date.now();
  let bounces = 0;
  let isGrounded = true;
  let justLanded = false;

  // Flight path tracking and teleportation detection
  let flightPath = [];
  let lastPosition = null;
  let lastPositionTime = null;
  let teleportWarnings = 0;
  let flightTerminated = false;
  let pathContinuityBroken = false;
  let resumeGracePeriod = false;
  let resumeGraceTimer = null;
  let lastPathChecksum = 0;
  let pathLengthHistory = [];
  let hasSeenMultiplePaths = false;
  let multiplePathsTimer = null;

// ====== Load airports database ======
fetch("https://raw.githubusercontent.com/mwgg/Airports/master/airports.json")
  .then(r => r.json())
  .then(data => {
    airportsDB = Object.entries(data).map(([icao, info]) => ({
      icao,
      lat: info.lat,
      lon: info.lon,
      tz: info.tz || null,
      name: info.name || "",
      city: info.city || "",
      country: info.country || ""
    }));
    console.log(`✅ Loaded ${airportsDB.length} airports`);
  })
  .catch(err => console.error("❌ Airport DB load failed:", err));

  function getNearestAirport(lat, lon) {
    if (!airportsDB.length) return { icao: "UNKNOWN" };
    let nearest = null, minDist = Infinity;
    for (const ap of airportsDB) {
      const dLat = (ap.lat - lat) * Math.PI / 180;
      const dLon = (ap.lon - lon) * Math.PI / 180;
      const a = Math.sin(dLat/2) ** 2 +
        Math.cos(lat * Math.PI/180) * Math.cos(ap.lat * Math.PI/180) *
        Math.sin(dLon/2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const dist = 6371 * c;
      if (dist < minDist) {
        minDist = dist;
        nearest = ap;
      }
    }
    if (nearest && minDist > 30) return null;
    return nearest || null;
  }

  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  function checkTeleportation(lat, lon, altitude) {
    if (!lastPosition || !flightStarted || flightTerminated) return false;
    if (resumeGracePeriod) return false;

    const now = Date.now();
    const timeDiff = (now - lastPositionTime) / 1000;

    if (timeDiff < 1) return false; // Increased from 0.5 to avoid rapid checks
    if (timeDiff > 10) return false; // Ignore if too much time passed (tab inactive, etc)

    const distance = calculateDistance(lastPosition.lat, lastPosition.lon, lat, lon);
    const altChange = Math.abs(altitude - lastPosition.altitude);

    // More lenient thresholds
    const maxRealisticDistance = timeDiff * 0.6; // Increased from 0.5
    const maxRealisticAltChange = timeDiff * 200; // Increased from 150

    // Only trigger if BOTH distance AND altitude are unrealistic
    if (distance > maxRealisticDistance && altChange > maxRealisticAltChange) {
      return true;
    }

    return false;
  }

  function handleTeleportation() {
    teleportWarnings++;

    if (teleportWarnings === 1) {
      showToast(
        "⚠️ TELEPORTATION DETECTED<br>Warning 1/2: Flight continues with note<br>Next teleport will terminate flight!",
        'warning',
        6000
      );
      console.warn("🚨 First teleportation warning issued");
    } else if (teleportWarnings >= 2) {
      flightTerminated = true;
      showToast(
        "🚫 FLIGHT TERMINATED<br>Multiple teleportations detected<br>Flight will not be logged",
        'crash',
        8000
      );
      console.error("❌ Flight terminated due to repeated teleportation");

      // Send termination message to Discord BEFORE clearing
      sendTerminationToDiscord();

      // Wait a bit for the message to send before clearing
      setTimeout(() => {
        if (monitorInterval) {
          clearInterval(monitorInterval);
          monitorInterval = null;
        }

        clearSession();
        resetPanel();
      }, 500);

      alert("⚠️ Flight Terminated\n\nMultiple teleportations detected. This flight will not be logged.\n\nPlease fly realistically without using location reset or slew mode.");
    }
  }

  function updateFlightPath(lat, lon, altitude) {
    const now = Date.now();

    // Check if GeoFS map path was cleared (teleportation indicator)
    if (typeof flight !== 'undefined' && flight.recorder && flight.recorder.mapPath) {
      const currentMapPathLength = flight.recorder.mapPath.length;

      // Track if we've ever seen multiple paths (indicates flight is established)
      if (currentMapPathLength >= 2) {
        hasSeenMultiplePaths = true;
      }

      // Track path length history
      pathLengthHistory.push(currentMapPathLength);
      if (pathLengthHistory.length > 10) pathLengthHistory.shift();

      // Only check for clearing if we've established multiple paths before
      if (pathLengthHistory.length >= 5 && hasSeenMultiplePaths) {
        const previousAvg = pathLengthHistory.slice(0, -1).reduce((a, b) => a + b, 0) / (pathLengthHistory.length - 1);

        // If we HAD multiple paths and now dropped to 1, that's a teleport (clearing)
        if (previousAvg >= 1.5 && currentMapPathLength === 1 && flightStarted && !resumeGracePeriod) {
          console.warn("🚨 Path clearing detected: " + Math.round(previousAvg) + " paths → " + currentMapPathLength + " path (teleportation)");
          pathContinuityBroken = true;
        }
      }
    }

    if (flightStarted && lastPosition && !flightTerminated) {
      if (checkTeleportation(lat, lon, altitude)) {
        handleTeleportation();
        if (flightTerminated) return;
      }
    }

    lastPosition = { lat, lon, altitude };
    lastPositionTime = now;

    if (!flightPath.length || (now - flightPath[flightPath.length - 1].time) > 5000) {
      flightPath.push({
        lat: lat,
        lon: lon,
        alt: altitude,
        time: now
      });

      if (flightPath.length % 10 === 0) {
        saveSession();
      }
    }
  }

  function saveSession() {
    const session = {
      flightStarted,
      flightStartTime,
      departureICAO,
      callsign: callsignInput?.value.trim() || "Unknown",
      aircraft: getAircraftName(),
      firstGroundContact,
      departureAirportData,
      flightPath: flightPath.slice(-50), // Keep last 50 points for resume continuity check
      teleportWarnings: teleportWarnings,
      timestamp: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function loadSession() {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function promptForAirportICAO(type, lat, lon) {
    const locationStr = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    const icao = prompt(`❓ ${type} airport not found in database.\nLocation: ${locationStr}\n\nPlease enter the ICAO code manually (or leave empty for UNKNOWN):`);
    return icao ? icao.toUpperCase().trim() : "UNKNOWN";
  }
function getAircraftName() {
  let raw = geofs?.aircraft?.instance?.aircraftRecord?.name || "Unknown";
  return raw.replace(/^\([^)]*\)\s*/, "");
}

  function saveAirlines(airlines) {
    localStorage.setItem(AIRLINES_KEY, JSON.stringify(airlines));
  }

  function loadAirlines() {
    const stored = localStorage.getItem(AIRLINES_KEY);
    if (stored) {
      const airlines = JSON.parse(stored);
      const firstKey = Object.keys(airlines)[0];
      if (firstKey && typeof airlines[firstKey] === 'string') {
        console.log("📦 Upgrading airline data format...");
        const upgraded = {};
        for (const [name, webhook] of Object.entries(airlines)) {
          upgraded[name] = {
            webhook: webhook,
            icao: name === 'Default' ? 'GFS' : 'UNK',
            iata: name === 'Default' ? 'GF' : 'UK'
          };
        }
        saveAirlines(upgraded);
        return upgraded;
      }
      if (firstKey && !airlines[firstKey].iata) {
        console.log("📦 Adding IATA field to existing airlines...");
        for (const [name, data] of Object.entries(airlines)) {
          if (typeof data === 'object' && !data.iata) {
            data.iata = data.icao ? data.icao.substring(0, 2) : 'UK';
          }
        }
        saveAirlines(airlines);
      }
      return airlines;
    }
    return {
      "Default": {
        webhook: WEBHOOK_URL,
        icao: "GFS",
        iata: "GF"
      }
    };
  }

  function saveLastAirline(airlineName) {
    localStorage.setItem(LAST_AIRLINE_KEY, airlineName);
  }

  function loadLastAirline() {
    return localStorage.getItem(LAST_AIRLINE_KEY);
  }

  function addNewAirline() {
    const name = prompt("Enter airline name:");
    if (!name) return;

    const icao = prompt("Enter airline ICAO code (e.g., EVA, CAL, CPA):");
    if (!icao) return;

    const iata = prompt("Enter airline IATA code (e.g., BR, CI, CX):");
    if (!iata) return;

    const webhook = prompt("Enter Discord webhook URL:");
    if (!webhook || !webhook.includes("discord.com/api/webhooks/")) {
      alert("Invalid webhook URL!");
      return;
    }

    const airlines = loadAirlines();
    airlines[name] = {
      webhook: webhook,
      icao: icao.toUpperCase().trim(),
      iata: iata.toUpperCase().trim()
    };
    saveAirlines(airlines);
    updateAirlineSelect();
    alert(`Added airline: ${name} (${icao.toUpperCase()}/${iata.toUpperCase()})`);
  }

  function editAirline() {
    const airlines = loadAirlines();
    const airlineNames = Object.keys(airlines);

    if (airlineNames.length === 0) {
      alert("No airlines to edit!");
      return;
    }

    const airlineList = airlineNames.map(name => {
      const data = airlines[name];
      const icao = data.icao || (typeof data === 'string' ? 'UNK' : 'UNK');
      const iata = data.iata || 'UK';
      return typeof data === 'object' ? `${name} (${icao}/${iata})` : name;
    }).join(", ");

    const selected = prompt(`Enter airline name to edit:\n${airlineList}`);
    if (!selected || !airlines[selected]) {
      alert("Airline not found!");
      return;
    }

    const currentData = airlines[selected];
    const currentICAO = currentData.icao || (typeof currentData === 'string' ? 'UNK' : 'UNK');
    const currentIATA = currentData.iata || 'UK';
    const currentWebhook = typeof currentData === 'object' ? currentData.webhook : currentData;

    const newName = prompt(`Enter new airline name (current: ${selected}):`, selected);
    if (!newName) return;

    const newICAO = prompt(`Enter new ICAO code (current: ${currentICAO}):`, currentICAO);
    if (!newICAO) return;

    const newIATA = prompt(`Enter new IATA code (current: ${currentIATA}):`, currentIATA);
    if (!newIATA) return;

    const newWebhook = prompt(`Enter new webhook URL (current: ${currentWebhook}):`, currentWebhook);
    if (!newWebhook || !newWebhook.includes("discord.com/api/webhooks/")) {
      alert("Invalid webhook URL!");
      return;
    }

    if (newName !== selected) {
      delete airlines[selected];
    }

    airlines[newName] = {
      webhook: newWebhook,
      icao: newICAO.toUpperCase().trim(),
      iata: newIATA.toUpperCase().trim()
    };

    saveAirlines(airlines);
    updateAirlineSelect();
    alert(`Updated airline: ${newName} (${newICAO.toUpperCase()}/${newIATA.toUpperCase()})`);
  }

  function removeAirline() {
    const airlines = loadAirlines();
    const airlineNames = Object.keys(airlines);

    if (airlineNames.length <= 1) {
      alert("Cannot remove the last airline!");
      return;
    }

    const airlineList = airlineNames.map(name => {
      const data = airlines[name];
      const icao = data.icao || (typeof data === 'string' ? 'UNK' : 'UNK');
      const iata = data.iata || 'UK';
      return typeof data === 'object' ? `${name} (${icao}/${iata})` : name;
    }).join(", ");

    const selected = prompt(`Enter airline name to remove:\n${airlineList}`);
    if (selected && airlines[selected]) {
      delete airlines[selected];
      saveAirlines(airlines);
      updateAirlineSelect();
      alert(`Removed airline: ${selected}`);
    } else {
      alert("Airline not found!");
    }
  }

  function updateAirlineSelect() {
    const airlines = loadAirlines();
    const lastAirline = loadLastAirline();

    airlineSelect.innerHTML = "";

    for (const [name, airlineData] of Object.entries(airlines)) {
      const option = document.createElement("option");

      if (typeof airlineData === 'string') {
        option.value = airlineData;
        option.textContent = name;
      } else {
        option.value = airlineData.webhook;
        const icao = airlineData.icao || 'UNK';
        const iata = airlineData.iata || 'UK';
        option.textContent = `${name} (${icao}/${iata})`;
      }

      option.setAttribute('data-airline-name', name);
      airlineSelect.appendChild(option);
    }

    if (lastAirline) {
      const targetOption = Array.from(airlineSelect.options).find(
        option => option.getAttribute('data-airline-name') === lastAirline
      );
      if (targetOption) {
        airlineSelect.value = targetOption.value;
        console.log(`✅ Restored last selected airline: ${lastAirline}`);
      }
    }

    airlineSelect.removeEventListener('change', airlineChangeHandler);
    airlineSelect.addEventListener('change', airlineChangeHandler);
  }

  function airlineChangeHandler() {
    const selectedOption = airlineSelect.options[airlineSelect.selectedIndex];
    const airlineName = selectedOption.getAttribute('data-airline-name');
    if (airlineName) {
      saveLastAirline(airlineName);
      console.log(`💾 Saved airline selection: ${airlineName}`);
    }
  }

  function getCurrentWebhookURL() {
    const airlines = loadAirlines();
    const selectedOption = airlineSelect.options[airlineSelect.selectedIndex];
    const airlineName = selectedOption?.getAttribute('data-airline-name');

    if (airlineName && airlines[airlineName]) {
      const airlineData = airlines[airlineName];
      return typeof airlineData === 'object' ? airlineData.webhook : airlineData;
    }

    return airlineSelect.value || WEBHOOK_URL;
  }

  function getCurrentAirlineICAO() {
    const airlines = loadAirlines();
    const selectedOption = airlineSelect.options[airlineSelect.selectedIndex];
    const airlineName = selectedOption?.getAttribute('data-airline-name');

    if (airlineName && airlines[airlineName]) {
      const airlineData = airlines[airlineName];
      return typeof airlineData === 'object' ? airlineData.icao : 'GFS';
    }
    return 'GFS';
  }

  function formatTimeWithTimezone(timestamp, airportData) {
    let timeZone = 'UTC';
    let suffix = 'UTC';

    if (airportData && airportData.tz) {
      timeZone = airportData.tz;
      const date = new Date(timestamp);
      const timezoneName = date.toLocaleDateString('en', {
        timeZone: timeZone,
        timeZoneName: 'short'
      }).split(', ')[1] || timeZone.split('/')[1] || 'LT';
      suffix = timezoneName;
    }

    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    return `${fmt.format(new Date(timestamp))} ${suffix}`;
  }

  function sendTerminationToDiscord() {
    if (!callsignInput || !flightStartTime || !departureICAO) {
      console.warn("⚠️ Cannot send termination - missing flight data");
      return;
    }

    const baseCallsign = callsignInput.value.trim() || "Unknown";
    const airlineICAO = getCurrentAirlineICAO();
    const pilot = baseCallsign.toUpperCase().startsWith(airlineICAO) ?
      baseCallsign : `${airlineICAO}${baseCallsign}`;
    const aircraft = getAircraftName();
    const durationMin = Math.round((Date.now() - flightStartTime) / 60000);
    const hours = Math.floor(durationMin / 60);
    const minutes = durationMin % 60;
    const formattedDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

    const message = {
      embeds: [{
        title: "🚫 Flight Terminated - GeoFS",
        color: 0xFF0000,
        fields: [
          {
            name: "✈️ Flight Information",
            value: `**Flight no.**: ${pilot}\n**Pilot name**: ${geofs?.userRecord?.callsign || "Unknown"}\n**Aircraft**: ${aircraft}`,
            inline: false
          },
          {
            name: "📍 Route",
            value: `**Departure**: ${departureICAO}\n**Arrival**: TELEPORT`,
            inline: true
          },
          {
            name: "⏱️ Duration",
            value: `**Flight Time**: ${formattedDuration}`,
            inline: true
          },
          {
            name: "⚠️ Termination Reason",
            value: `**Multiple teleportations detected**\nFlight integrity compromised after 2 warnings.`,
            inline: false
          }
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: "GeoFS Flight Logger | Flight Not Logged"
        }
      }]
    };

    console.log("📤 Sending termination notice to Discord");
    fetch(getCurrentWebhookURL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message)
    }).then(() => console.log("✅ Termination notice sent"))
      .catch(err => console.error("❌ Failed to send termination notice:", err));
  }

  function sendLogToDiscord(data) {
    const takeoffTime = formatTimeWithTimezone(data.takeoff, departureAirportData);
    const landingTime = formatTimeWithTimezone(data.landing, arrivalAirportData);

    let embedColor;
    switch(data.landingQuality) {
      case "SUPER BUTTER": embedColor = 0x00FF00; break;
      case "BUTTER": embedColor = 0x00FF00; break;
      case "ACCEPTABLE": embedColor = 0xFFFF00; break;
      case "HARD": embedColor = 0xFF8000; break;
      case "CRASH": embedColor = 0xDC143C; break; // Crimson red for crash
      default: embedColor = 0x0099FF; break;
    }

    const fields = [
      {
        name: "✈️ Flight Information",
        value: `**Flight no.**: ${data.pilot}\n**Pilot name**: ${geofs?.userRecord?.callsign || "Unknown"}\n**Aircraft**: ${data.aircraft}`,
        inline: false
      },
      {
        name: "📍 Route",
        value: `**Departure**: ${data.dep}\n**Arrival**: ${data.arr}`,
        inline: true
      },
      {
        name: "⏱️ Duration",
        value: `**Flight Time**: ${data.duration}`,
        inline: true
      },
      {
        name: "📊 Flight Data",
        value: `**V/S**: ${data.vs} fpm\n**G-Force**: ${data.gforce}\n**TAS**: ${data.ktrue} kts\n**GS**: ${data.gs} kts`,
        inline: true
      },
      {
        name: "🏁 Landing Quality",
        value: `**${data.landingQuality}**${data.bounces > 0 ? `\n**Bounces**: ${data.bounces}` : ''}`,
        inline: true
      },
      {
        name: "🕓 Times",
        value: `**Takeoff**: ${takeoffTime}\n**Landing**: ${landingTime}`,
        inline: false
      }
    ];

    if (data.teleportWarnings > 0) {
      fields.push({
        name: "⚠️ Flight Integrity Alert",
        value: `**Teleportation detected**: ${data.teleportWarnings} time(s)\n*Flight continued with noted violation*`,
        inline: false
      });
      embedColor = 0xFFA500;
    }

    const message = {
      embeds: [{
        title: "🛫 Flight Report - GeoFS",
        color: embedColor,
        fields: fields,
        timestamp: new Date().toISOString(),
        footer: {
          text: "GeoFS Flight Logger" + (data.teleportWarnings > 0 ? " | ⚠️ Integrity Warning" : "")
        }
      }]
    };

    fetch(getCurrentWebhookURL(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message)
    }).then(() => console.log("✅ Flight log sent"))
      .catch(console.error);
  }

  function showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position: 'fixed',
      top: '20px',
      right: '20px',
      padding: '12px 20px',
      borderRadius: '8px',
      color: 'white',
      fontWeight: 'bold',
      fontSize: '14px',
      fontFamily: 'sans-serif',
      zIndex: '10001',
      minWidth: '300px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      opacity: '0',
      transform: 'translateX(100%)',
      transition: 'all 0.3s ease-in-out'
    });
    switch(type) {
      case 'crash': toast.style.background = 'linear-gradient(135deg, #ff4444, #cc0000)'; break;
      case 'success': toast.style.background = 'linear-gradient(135deg, #00ff44, #00cc00)'; break;
      case 'warning': toast.style.background = 'linear-gradient(135deg, #ffaa00, #ff8800)'; break;
      default: toast.style.background = 'linear-gradient(135deg, #0099ff, #0066cc)';
    }
    toast.innerHTML = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; }, 10);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => { if (document.body.contains(toast)) document.body.removeChild(toast); }, 300);
    }, duration);
  }

  function updateCalVertS() {
    if ((typeof geofs.animation.values != 'undefined' &&
         !geofs.isPaused()) &&
        ((geofs.animation.values.altitude !== undefined && geofs.animation.values.groundElevationFeet !== undefined) ? ((geofs.animation.values.altitude - geofs.animation.values.groundElevationFeet) + (geofs.aircraft.instance.collisionPoints[geofs.aircraft.instance.collisionPoints.length - 2].worldPosition[2]*3.2808399)) : 'N/A') !== oldAGL) {
        newAGL = (geofs.animation.values.altitude !== undefined && geofs.animation.values.groundElevationFeet !== undefined) ? ((geofs.animation.values.altitude - geofs.animation.values.groundElevationFeet) + (geofs.aircraft.instance.collisionPoints[geofs.aircraft.instance.collisionPoints.length - 2].worldPosition[2]*3.2808399)) : 'N/A';
        newTime = Date.now();
        calculatedVerticalSpeed = (newAGL - oldAGL) * (60000/(newTime - oldTime));
        oldAGL = (geofs.animation.values.altitude !== undefined && geofs.animation.values.groundElevationFeet !== undefined) ? ((geofs.animation.values.altitude - geofs.animation.values.groundElevationFeet) + (geofs.aircraft.instance.collisionPoints[geofs.aircraft.instance.collisionPoints.length - 2].worldPosition[2]*3.2808399)) : 'N/A';
        oldTime = Date.now();
    }
  }

  function monitorFlight() {
    if (!geofs?.animation?.values || !geofs.aircraft?.instance) return;
    if (flightTerminated) return;

    const values = geofs.animation.values;
    const onGround = values.groundContact;
    const altitudeFt = values.altitude * 3.28084;
    const terrainFt = geofs.api?.map?.getTerrainAltitude?.() * 3.28084 || 0;
    const agl = altitudeFt - terrainFt;
    const [lat, lon] = geofs.aircraft.instance.llaLocation || [values.latitude, values.longitude];
    const now = Date.now();

    if (flightStarted) {
      updateFlightPath(lat, lon, altitudeFt);
      if (flightTerminated) return;
    }

    const enhancedAGL = (values.altitude !== undefined && values.groundElevationFeet !== undefined) ?
      ((values.altitude - values.groundElevationFeet) +
       (geofs.aircraft.instance.collisionPoints[geofs.aircraft.instance.collisionPoints.length - 2].worldPosition[2] * 3.2808399))
      : 'N/A';

    if (enhancedAGL < 500) {
      justLanded = onGround && !isGrounded;
      isGrounded = onGround;
    }

    if (!flightStarted && !onGround && agl > 100) {
      flightStarted = true;
      flightStartTime = now;
      const nearestAirport = getNearestAirport(lat, lon);
      if (nearestAirport) {
        departureICAO = nearestAirport.icao;
        departureAirportData = nearestAirport;
      } else {
        departureICAO = promptForAirportICAO("Departure", lat, lon);
        departureAirportData = null;
      }

      flightPath = [];
      lastPosition = { lat, lon, altitude: altitudeFt };
      lastPositionTime = now;
      teleportWarnings = 0;
      flightTerminated = false;
      pathContinuityBroken = false;
      resumeGracePeriod = false;
      pathLengthHistory = [];
      hasSeenMultiplePaths = false;
      if (resumeGraceTimer) clearTimeout(resumeGraceTimer);
      if (multiplePathsTimer) clearTimeout(multiplePathsTimer);

      // Set hasSeenMultiplePaths to true after 15 seconds
      multiplePathsTimer = setTimeout(() => {
        hasSeenMultiplePaths = true;
        console.log("📍 Multiple paths detection enabled after 15s");
      }, 15000);

      saveSession();
      console.log(`🛫 Departure detected at ${departureICAO}`);
      if (panelUI) {
        if (window.instruments && window.instruments.visible) {
          panelUI.style.opacity = "0";
          setTimeout(() => panelUI.style.display = "none", 500);
        }
      }
    }

    const elapsed = (now - flightStartTime) / 1000;
    if (flightStarted && !firstGroundContact && onGround) {
      if (elapsed < 1) return;

      if (justLanded) {
        bounces++;
      }

      const vs = calculatedVerticalSpeed !== 0 && Math.abs(calculatedVerticalSpeed) < 5000
        ? calculatedVerticalSpeed
        : values.verticalSpeed || 0;

      let quality;
      if (vs >= -50) {
        quality = "SUPER BUTTER";
      } else if (vs >= -200) {
        quality = "BUTTER";
      } else if (vs >= -500) {
        quality = "ACCEPTABLE";
      } else if (vs >= -1000) {
        quality = "HARD";
      } else {
        quality = "CRASH";
      }

      if (vs <= -1000 || vs > 200) {
        showToast("💥 CRASH DETECTED<br>Logging crash report...", 'crash', 4000);
        const nearestAirport = getNearestAirport(lat, lon);
        if (nearestAirport) {
          arrivalICAO = "Crash";
          arrivalAirportData = nearestAirport;
        } else {
          arrivalICAO = "Crash";
          arrivalAirportData = null;
        }
      } else {
        const nearestAirport = getNearestAirport(lat, lon);
        if (nearestAirport) {
          arrivalICAO = nearestAirport.icao;
          arrivalAirportData = nearestAirport;
        } else {
          arrivalICAO = promptForAirportICAO("Arrival", lat, lon);
          arrivalAirportData = null;
        }
      }

      console.log(`🛬 Arrival detected at ${arrivalICAO}`);
      console.log(`📊 Landing data: V/S = ${vs.toFixed(1)} fpm (${typeof window.calVertS !== 'undefined' && Math.abs(window.calVertS) < 5000 ? 'landing-stats-calibrated' : calculatedVerticalSpeed !== 0 ? 'calculated' : 'geofs'}), Quality = ${quality}`);
      console.log(`🛤️ Flight path points recorded: ${flightPath.length}`);
      if (teleportWarnings > 0) {
        console.warn(`⚠️ Teleportation warnings: ${teleportWarnings}`);
      }

      firstGroundContact = true;
      firstGroundTime = now;

      const g = (values.accZ / 9.80665).toFixed(2);
      const gs = values.groundSpeedKnt.toFixed(1);
      const tas = geofs.aircraft.instance.trueAirSpeed?.toFixed(1) || "N/A";

      // Get bounces from Landing Stats addon if available
      const landingBounces = typeof window.bounces !== 'undefined' ? window.bounces : bounces;

      const baseCallsign = callsignInput.value.trim() || "Unknown";
      const airlineICAO = getCurrentAirlineICAO();
      const pilot = baseCallsign.toUpperCase().startsWith(airlineICAO) ?
        baseCallsign : `${airlineICAO}${baseCallsign}`;
      const aircraft = getAircraftName();
      const durationMin = Math.round((firstGroundTime - flightStartTime) / 60000);

      const hours = Math.floor(durationMin / 60);
      const minutes = durationMin % 60;
      const formattedDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

      console.log(`📤 Sending log to Discord: Pilot=${pilot}, Aircraft=${aircraft}, V/S=${vs.toFixed(1)}, Quality=${quality}`);

      sendLogToDiscord({
        pilot, aircraft,
        takeoff: flightStartTime,
        landing: firstGroundTime,
        dep: departureICAO,
        arr: arrivalICAO,
        duration: formattedDuration,
        vs: vs.toFixed(1),
        gforce: g,
        gs: gs,
        ktrue: tas,
        landingQuality: quality,
        bounces: landingBounces,
        teleportWarnings: teleportWarnings
      });

      saveSession();
      clearSession();
      resetPanel();

      if (panelUI) {
        panelUI.style.display = "block";
        panelUI.style.opacity = "0.5";
      }

      if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
      }
    }
  }

  function resetPanel() {
    flightStarted = false;
    hasLanded = false;
    firstGroundContact = false;
    flightStartTime = null;
    departureICAO = "UNKNOWN";
    arrivalICAO = "UNKNOWN";
    departureAirportData = null;
    arrivalAirportData = null;

    bounces = 0;
    isGrounded = true;
    justLanded = false;
    calculatedVerticalSpeed = 0;
    oldAGL = 0;
    newAGL = 0;
    oldTime = Date.now();
    newTime = Date.now();

    flightPath = [];
    lastPosition = null;
    lastPositionTime = null;
    teleportWarnings = 0;
    flightTerminated = false;
    pathContinuityBroken = false;
    resumeGracePeriod = false;
    pathLengthHistory = [];
    hasSeenMultiplePaths = false;
    if (resumeGraceTimer) clearTimeout(resumeGraceTimer);
    if (multiplePathsTimer) clearTimeout(multiplePathsTimer);

    callsignInput.value = "";
    startButton.disabled = true;
    startButton.innerText = "📋 Start Flight Logger";
    if (panelUI) {
      if (window.instruments && window.instruments.visible) {
        panelUI.style.display = "block";
        panelUI.style.opacity = "0.92";
      }
    }
  }

  function hasAgreedToTerms() {
    return localStorage.getItem(TERMS_AGREED_KEY) === 'true';
  }

  function setTermsAgreed() {
    localStorage.setItem(TERMS_AGREED_KEY, 'true');
  }

  function showTermsDialog() {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      zIndex: '10000',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center'
    });

    const dialog = document.createElement('div');
    Object.assign(dialog.style, {
      background: '#1a1a1a',
      color: 'white',
      padding: '30px',
      borderRadius: '10px',
      border: '2px solid #444',
      maxWidth: '600px',
      maxHeight: '80vh',
      overflow: 'auto',
      fontFamily: 'sans-serif'
    });

    dialog.innerHTML = `
      <h2 style="color: #00C8FF; margin-top: 0;">GeoFS SAW Flight Logger - Terms of Use</h2>
      <div style="background: #2a2a2a; padding: 20px; border-radius: 5px; margin: 20px 0; max-height: 300px; overflow-y: auto;">
        <h3>📜 Terms and Conditions of the SAW System</h3>
        <div style="background: #333; padding: 15px; border-left: 4px solid #00C8FF; margin: 15px 0;">
          <p><strong>1. Flight Integrity Agreement</strong><br>
          You agree not to fake flights with this script. All recorded flights must be genuine flight simulation activities performed in GeoFS.</p>
          <p><strong>2. Modification Restrictions</strong><br>
          You agree not to make any major changes to this script without giving notice to the creator due to technical reasons and system integrity requirements.</p>
          <p><strong>3. Pilot Preparation Responsibility</strong><br>
          You agree to give pilots decent preparation for using this script, including proper training and understanding of its functionality before deployment.</p>
        </div>
        <h4>📋 Additional Terms:</h4>
        <p><strong>4. Purpose Statement</strong><br>
        This script is intended solely for GeoFS flight simulation logging purposes and must not be used for commercial purposes or illegal activities.</p>
        <p><strong>5. Data Responsibility</strong><br>
        • Users are responsible for the security of their Discord Webhook URLs<br>
        • Users must ensure they have permission to use the configured Discord servers<br>
        • This script does not store or transmit any personal sensitive information</p>
        <p><strong>6. Disclaimer</strong><br>
        • This script is provided "as is" without any form of warranty<br>
        • The author is not responsible for any losses caused by using this script<br>
        • Users assume all risks of use</p>
        <p><strong>7. Data Processing</strong><br>
        This script only stores the following data locally:<br>
        • Airline settings and selection records<br>
        • Flight session states<br>
        • User preference settings</p>
        <p><strong>8. Terms Modification</strong><br>
        The author reserves the right to modify these terms at any time. Continued use indicates acceptance of the modified terms.</p>
      </div>
      <div style="text-align: center; margin-top: 25px;">
        <button id="agreeBtn" style="background: #00C8FF; color: white; border: none; padding: 12px 25px; margin: 0 10px; border-radius: 5px; cursor: pointer; font-size: 16px;">✅ I Agree</button>
        <button id="disagreeBtn" style="background: #ff4444; color: white; border: none; padding: 12px 25px; margin: 0 10px; border-radius: 5px; cursor: pointer; font-size: 16px;">❌ I Disagree</button>
      </div>
      <p style="text-align: center; margin-top: 20px; font-size: 12px; color: #888;">Selecting "I Disagree" will prevent the use of GeoFS SAW Flight Logger</p>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    document.getElementById('agreeBtn').addEventListener('click', function() {
      setTermsAgreed();
      document.body.removeChild(overlay);
      console.log("✅ User agreed to SAW system terms of use");
      createSidePanel();
      setTimeout(updatePanelVisibility, 1000);
    });

    document.getElementById('disagreeBtn').addEventListener('click', function() {
      document.body.removeChild(overlay);
      console.log("❌ User disagreed to SAW system terms of use - Flight Logger disabled");
      alert("You chose to disagree with the terms of use. GeoFS SAW Flight Logger will not be activated.");
    });

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) {
        e.preventDefault();
      }
    });
  }

  function disableKeyPropagation(input) {
    ["keydown", "keyup", "keypress"].forEach(ev =>
      input.addEventListener(ev, e => e.stopPropagation())
    );
  }

 function createSidePanel() {
    panelUI = document.createElement("div");
    Object.assign(panelUI.style, {
      position: "absolute",
      bottom: "50px",
      left: "10px",
      background: "#111",
      color: "white",
      padding: "10px",
      border: "2px solid white",
      zIndex: "21",
      width: "220px",
      fontSize: "14px",
      fontFamily: "sans-serif",
      transition: "opacity 0.5s ease",
      display: "block",
      opacity: "0.5"
    });

    const airlineLabel = document.createElement("div");
    airlineLabel.textContent = "Airline:";
    airlineLabel.style.marginBottom = "3px";
    airlineLabel.style.fontSize = "12px";
    panelUI.appendChild(airlineLabel);

    airlineSelect = document.createElement("select");
    airlineSelect.style.width = "100%";
    airlineSelect.style.marginBottom = "6px";
    panelUI.appendChild(airlineSelect);

    const airlineButtons = document.createElement("div");
    airlineButtons.style.display = "flex";
    airlineButtons.style.gap = "3px";
    airlineButtons.style.marginBottom = "6px";

    const addAirlineBtn = document.createElement("button");
    addAirlineBtn.textContent = "+ Add";
    Object.assign(addAirlineBtn.style, {
      flex: "1",
      padding: "3px",
      background: "#006600",
      color: "white",
      border: "1px solid white",
      cursor: "pointer",
      fontSize: "9px"
    });
    addAirlineBtn.onclick = addNewAirline;

    const editAirlineBtn = document.createElement("button");
    editAirlineBtn.textContent = "Modify";
    Object.assign(editAirlineBtn.style, {
      flex: "1",
      padding: "3px",
      background: "#0066aa",
      color: "white",
      border: "1px solid white",
      cursor: "pointer",
      fontSize: "9px"
    });
    editAirlineBtn.onclick = editAirline;

    const removeAirlineBtn = document.createElement("button");
    removeAirlineBtn.textContent = "- Remove";
    Object.assign(removeAirlineBtn.style, {
      flex: "1",
      padding: "3px",
      background: "#660000",
      color: "white",
      border: "1px solid white",
      cursor: "pointer",
      fontSize: "9px"
    });
    removeAirlineBtn.onclick = removeAirline;

    airlineButtons.appendChild(addAirlineBtn);
    airlineButtons.appendChild(editAirlineBtn);
    airlineButtons.appendChild(removeAirlineBtn);
    panelUI.appendChild(airlineButtons);

    callsignInput = document.createElement("input");
    callsignInput.placeholder = "Callsign";
    callsignInput.style.width = "100%";
    callsignInput.style.marginBottom = "6px";
    disableKeyPropagation(callsignInput);
    callsignInput.onkeyup = () => {
      startButton.disabled = callsignInput.value.trim() === "";
    };
    startButton = document.createElement("button");
    startButton.innerText = "📋 Start Flight Logger";
    startButton.disabled = true;
    Object.assign(startButton.style, {
      width: "100%",
      padding: "6px",
      background: "#333",
      color: "white",
      border: "1px solid white",
      cursor: "pointer"
    });

    startButton.onclick = () => {
      alert("Flight Logger activated! Start your flight when ready.");
      monitorInterval = setInterval(monitorFlight, 1000);
      setInterval(updateCalVertS, 25);
      startButton.innerText = "✅ Logger Running...";
      startButton.disabled = true;
    };

    panelUI.appendChild(callsignInput);
    panelUI.appendChild(startButton);

    const resumeSession = loadSession();
    const resumeBtn = document.createElement("button");
    resumeBtn.innerText = "⏪ Resume Last Flight";
    Object.assign(resumeBtn.style, {
      width: "100%",
      marginTop: "6px",
      padding: "6px",
      background: "#222",
      color: "white",
      border: "1px solid white",
      cursor: "pointer"
    });

    resumeBtn.onclick = () => {
      if (resumeSession) {
        flightStarted = true;
        flightStartTime = resumeSession.flightStartTime;
        departureICAO = resumeSession.departureICAO;
        departureAirportData = resumeSession.departureAirportData;
        firstGroundContact = resumeSession.firstGroundContact || false;
        callsignInput.value = resumeSession.callsign || "";

        flightPath = resumeSession.flightPath || [];
        teleportWarnings = resumeSession.teleportWarnings || 0;
        flightTerminated = false;
        pathContinuityBroken = false;

        // Enable grace period for resume to avoid false teleport detection
        resumeGracePeriod = true;
        pathLengthHistory = [];
        hasSeenMultiplePaths = false;
        if (multiplePathsTimer) clearTimeout(multiplePathsTimer);

        resumeGraceTimer = setTimeout(() => {
          resumeGracePeriod = false;
          console.log("📍 Resume grace period ended, teleportation detection active");
        }, 5000);

        multiplePathsTimer = setTimeout(() => {
          hasSeenMultiplePaths = true;
          console.log("📍 Multiple paths detection enabled after 15s");
        }, 15000); // Increased to 30 seconds

        if (flightPath.length > 0) {
          const lastPoint = flightPath[flightPath.length - 1];
          lastPosition = { lat: lastPoint.lat, lon: lastPoint.lon, altitude: lastPoint.alt };
          lastPositionTime = lastPoint.time;
          console.log("🔗 Path continuity restored from saved data");
        }

        monitorInterval = setInterval(monitorFlight, 1000);
        setInterval(updateCalVertS, 25);
        resumeBtn.innerText = "✅ Resumed!";
        resumeBtn.disabled = true;
        startButton.innerText = "✅ Logger Running...";
        startButton.disabled = true;
        console.log("🔁 Resumed flight session.");
        if (panelUI && window.instruments && window.instruments.visible) {
          panelUI.style.opacity = "0";
          setTimeout(() => panelUI.style.display = "none", 500);
        }
      } else {
        alert("❌ No previous session found.");
      }
    };

    panelUI.appendChild(resumeBtn);
    document.body.appendChild(panelUI);
    updateAirlineSelect();
  }

  function updatePanelVisibility() {
    if (panelUI) {
      panelUI.style.display = (window.instruments && window.instruments.visible) ? "block" : "none";
    }
    setTimeout(updatePanelVisibility, 100);
  }

  function checkAutoResume() {
    const resumeSession = loadSession();
    if (resumeSession && resumeSession.flightStarted && resumeSession.callsign) {
      const sessionAge = (Date.now() - resumeSession.timestamp) / (1000 * 60);

      if (sessionAge < 240) {
        console.log(`🔄 Auto-resuming flight session: ${resumeSession.callsign} from ${resumeSession.departureICAO}`);

        flightStarted = true;
        flightStartTime = resumeSession.flightStartTime;
        departureICAO = resumeSession.departureICAO;
        departureAirportData = resumeSession.departureAirportData;
        firstGroundContact = resumeSession.firstGroundContact || false;

        flightPath = resumeSession.flightPath || [];
        teleportWarnings = resumeSession.teleportWarnings || 0;
        flightTerminated = false;
        pathContinuityBroken = false;

        resumeGracePeriod = true;
        pathLengthHistory = [];
        hasSeenMultiplePaths = false;
        if (multiplePathsTimer) clearTimeout(multiplePathsTimer);

        resumeGraceTimer = setTimeout(() => {
          resumeGracePeriod = false;
          console.log("📍 Resume grace period ended, teleportation detection active");
        }, 5000);

        multiplePathsTimer = setTimeout(() => {
          hasSeenMultiplePaths = true;
          console.log("📍 Multiple paths detection enabled after 15s");
        }, 15000);

        if (flightPath.length > 0) {
          const lastPoint = flightPath[flightPath.length - 1];
          lastPosition = { lat: lastPoint.lat, lon: lastPoint.lon, altitude: lastPoint.alt };
          lastPositionTime = lastPoint.time;
          console.log("🔗 Path continuity restored from saved data");
        }

        if (callsignInput) {
          callsignInput.value = resumeSession.callsign || "";
        }

        monitorInterval = setInterval(monitorFlight, 1000);
        setInterval(updateCalVertS, 25);

        if (startButton) {
          startButton.innerText = "✅ Logger Running...";
          startButton.disabled = true;
        }

        const flightDuration = Math.floor((Date.now() - flightStartTime) / 60000);
        showToast(
          `🔄 Flight auto-resumed: ${resumeSession.callsign}<br>📍 From: ${resumeSession.departureICAO}<br>⏱️ Duration: ${flightDuration}min`,
          'success',
          6000
        );

        if (panelUI && window.instruments && window.instruments.visible) {
          panelUI.style.opacity = "0";
          setTimeout(() => panelUI.style.display = "none", 500);
        }

        return true;
      } else {
        console.log(`⏰ Session too old (${Math.floor(sessionAge / 60)}h ${Math.floor(sessionAge % 60)}m), not auto-resuming`);
        clearSession();
      }
    }
    return false;
  }

  window.addEventListener("load", () => {
    console.log("✅ GeoFS SAW Flight Logger (Auto ICAO, CDN JSON) Loaded");

    if (localStorage.getItem(TERMS_AGREED_KEY) === 'true') {
      console.log("✅ SAW system terms already agreed, initializing Flight Logger");
      createSidePanel();
      setTimeout(updatePanelVisibility, 1000);
      setTimeout(() => {
        checkAutoResume();
      }, 2000);
    } else {
      console.log("📋 First time user, showing SAW system terms of use");
      setTimeout(showTermsDialog, 2000);
    }
  });
})();

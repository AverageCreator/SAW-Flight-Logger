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

  function saveSession() {
    const session = {
      flightStarted,
      flightStartTime,
      departureICAO,
      callsign: callsignInput?.value.trim() || "Unknown",
      aircraft: aircraftInput?.value.trim() || "Unknown",
      firstGroundContact,
      departureAirportData,
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
  return raw.replace(/^\([^)]*\)\s*/, ""); // 去掉 (作者名) 部分
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
            icao: name === 'Default' ? 'GFS' : 'UNK'
          };
        }
        saveAirlines(upgraded);
        return upgraded;
      }
      return airlines;
    }
    return {
      "Default": {
        webhook: WEBHOOK_URL,
        icao: "GFS"
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

    const webhook = prompt("Enter Discord webhook URL:");
    if (!webhook || !webhook.includes("discord.com/api/webhooks/")) {
      alert("Invalid webhook URL!");
      return;
    }

    const airlines = loadAirlines();
    airlines[name] = {
      webhook: webhook,
      icao: icao.toUpperCase().trim()
    };
    saveAirlines(airlines);
    updateAirlineSelect();
    alert(`Added airline: ${name} (${icao.toUpperCase()})`);
  }

  function removeAirline() {
    const airlines = loadAirlines();
    const airlineNames = Object.keys(airlines);

    if (airlineNames.length <= 1) {
      alert("Cannot remove the last airline!");
      return;
    }

    const airlineList = airlineNames.map(name => {
      const icao = airlines[name].icao || airlines[name];
      return typeof airlines[name] === 'object' ? `${name} (${icao})` : name;
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
        option.textContent = `${name} (${airlineData.icao})`;
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

  function sendLogToDiscord(data) {
    const takeoffTime = formatTimeWithTimezone(data.takeoff, departureAirportData);
    const landingTime = formatTimeWithTimezone(data.landing, arrivalAirportData);

    let embedColor;
    switch(data.landingQuality) {
      case "BUTTER": embedColor = 0x00FF00; break;
      case "HARD": embedColor = 0xFF8000; break;
      case "CRASH": embedColor = 0xFF0000; break;
      default: embedColor = 0x0099FF; break;
    }

    const message = {
      embeds: [{
        title: "🛫 Flight Report - GeoFS",
        color: embedColor,
        fields: [
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
            value: `**${data.landingQuality}**`,
            inline: true
          },
          {
            name: "🕓 Times",
            value: `**Takeoff**: ${takeoffTime}\n**Landing**: ${landingTime}`,
            inline: false
          }
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: "GeoFS Flight Logger"
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

  function monitorFlight() {
    if (!geofs?.animation?.values || !geofs.aircraft?.instance) return;
    const values = geofs.animation.values;
    const onGround = values.groundContact;
    const altitudeFt = values.altitude * 3.28084;
    const terrainFt = geofs.api?.map?.getTerrainAltitude?.() * 3.28084 || 0;
    const agl = altitudeFt - terrainFt;
    const [lat, lon] = geofs.aircraft.instance.llaLocation || [values.latitude, values.longitude];
    const now = Date.now();

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
      saveSession();
      console.log(`🛫 Departure detected at ${departureICAO}`);
      // 已移除 showToast(起飛)
      if (panelUI) {
        if (window.instruments && window.instruments.visible) {
          panelUI.style.opacity = "0";
          setTimeout(() => panelUI.style.display = "none", 500);
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
  callsignInput.value = "";
  startButton.disabled = true;
  startButton.innerText = "📋 Start Flight Logger";

  if (panelUI) {
    if (window.instruments && window.instruments.visible) {
      panelUI.style.display = "block";  // ✅ 重新顯示
      panelUI.style.opacity = "0.5";    // ✅ 回復透明度
    }
  }
}

    const elapsed = (now - flightStartTime) / 1000;
    if (flightStarted && !firstGroundContact && onGround) {
      if (elapsed < 1) return;
      const vs = values.verticalSpeed;
      if (vs <= -800) {
  showToast("💥 CRASH DETECTED<br>Logging crash report...", 'crash', 4000);
  const nearestAirport = getNearestAirport(lat, lon);
  if (nearestAirport) {
    arrivalICAO = "Crash";
    arrivalAirportData = nearestAirport;  // ✅ 用最近的機場資料抓時區
  } else {
    arrivalICAO = "Crash";
    arrivalAirportData = null;            // 找不到才回退
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
      // 已移除 showToast(到達完成)
      firstGroundContact = true;
      firstGroundTime = now;

      const g = (values.accZ / 9.80665).toFixed(2);
      const gs = values.groundSpeedKnt.toFixed(1);
      const tas = geofs.aircraft.instance.trueAirSpeed?.toFixed(1) || "N/A";
      const quality = (vs > -60) ? "BUTTER" : (vs > -800) ? "HARD" : "CRASH";
      const baseCallsign = callsignInput.value.trim() || "Unknown";
      const airlineICAO = getCurrentAirlineICAO();
      const pilot = baseCallsign.toUpperCase().startsWith(airlineICAO) ?
        baseCallsign : `${airlineICAO}${baseCallsign}`;
      const aircraft = getAircraftName();
      const durationMin = Math.round((firstGroundTime - flightStartTime) / 60000);

      const hours = Math.floor(durationMin / 60);
      const minutes = durationMin % 60;
      const formattedDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

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
        landingQuality: quality
      });

      saveSession();
      clearSession();
      resetPanel();

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
    callsignInput.value = "";
    aircraftInput.value = "";
    startButton.disabled = true;
    startButton.innerText = "📋 Start Flight Logger";
    if (panelUI) {
      if (window.instruments && window.instruments.visible) {
        panelUI.style.display = "block";
        panelUI.style.opacity = "0.5";
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
        <button id="agreeBtn" style="
          background: #00C8FF;
          color: white;
          border: none;
          padding: 12px 25px;
          margin: 0 10px;
          border-radius: 5px;
          cursor: pointer;
          font-size: 16px;
        ">✅ I Agree</button>

        <button id="disagreeBtn" style="
          background: #ff4444;
          color: white;
          border: none;
          padding: 12px 25px;
          margin: 0 10px;
          border-radius: 5px;
          cursor: pointer;
          font-size: 16px;
        ">❌ I Disagree</button>
      </div>

      <p style="text-align: center; margin-top: 20px; font-size: 12px; color: #888;">
        Selecting "I Disagree" will prevent the use of GeoFS SAW Flight Logger
      </p>
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
    airlineButtons.style.gap = "4px";
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
      fontSize: "10px"
    });
    addAirlineBtn.onclick = addNewAirline;

    const removeAirlineBtn = document.createElement("button");
    removeAirlineBtn.textContent = "- Remove";
    Object.assign(removeAirlineBtn.style, {
      flex: "1",
      padding: "3px",
      background: "#660000",
      color: "white",
      border: "1px solid white",
      cursor: "pointer",
      fontSize: "10px"
    });
    removeAirlineBtn.onclick = removeAirline;

    airlineButtons.appendChild(addAirlineBtn);
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
        aircraftInput.value = resumeSession.aircraft || "";
        monitorInterval = setInterval(monitorFlight, 1000);
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
window.addEventListener("load", () => {
    console.log("✅ GeoFS SAW Flight Logger (Auto ICAO, CDN JSON) Loaded");

    if (localStorage.getItem(TERMS_AGREED_KEY) === 'true') {
      console.log("✅ SAW system terms already agreed, initializing Flight Logger");
      createSidePanel();
      setTimeout(updatePanelVisibility, 1000);
    } else {
      console.log("📋 First time user, showing SAW system terms of use");
      setTimeout(showTermsDialog, 2000);
    }
  });
})();

// ==UserScript==
// @name         Auto-Airport Flight Logger (GeoFS)
// @namespace    https://your-va.org/flightlogger
// @version      2025-08-16
// @description  Logs flights with crash detection, auto ICAO detection, session recovery & terrain-based AGL check
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const WEBHOOK_URL = "https://discord.com/api/webhooks/1396707133470408837/yUFY7rR3HSxYOvbeqqTniQxtSlPJ7SSfFVN4JqK9-nEdGfJ6BI5o39XIbf5Zdi0Sav3w";
  const STORAGE_KEY = "geofs_flight_logger_session";

  let flightStarted = false;
  let flightStartTime = null;
  let departureICAO = "UNKNOWN";
  let arrivalICAO = "UNKNOWN";
  let hasLanded = false;
  let monitorInterval = null;
  let firstGroundContact = false;
  let firstGroundTime = null;
  let panelUI, startButton, callsignInput, aircraftInput;
  let airportsDB = [];
  let departureAirportData = null; // 儲存起飛機場資料
  let arrivalAirportData = null;   // 儲存降落機場資料

  // ====== Load airports database ======
  fetch("https://raw.githubusercontent.com/seabus0316/GeoFS-METAR-system/refs/heads/main/airports_with_tz.json")
    .then(r => r.json())
    .then(data => {
      airportsDB = Object.entries(data).map(([icao, info]) => ({ icao, ...info }));
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
    if (nearest && minDist > 30) return { icao: "UNKNOWN" };
    return nearest || { icao: "UNKNOWN" };
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

  function formatTimeWithTimezone(timestamp, airportData) {
    // 如果有機場時區資料，使用機場時區，否則使用UTC
    let timeZone = 'UTC';
    let suffix = 'UTC';

    if (airportData && airportData.tz) {
      timeZone = airportData.tz;
      // 取得時區簡寫 (例如 Asia/Taipei -> CST)
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
    // 使用起飛和降落機場的本地時間
    const takeoffTime = formatTimeWithTimezone(data.takeoff, departureAirportData);
    const landingTime = formatTimeWithTimezone(data.landing, arrivalAirportData);

    // 根據降落品質決定顏色
    let embedColor;
    switch(data.landingQuality) {
      case "BUTTER": embedColor = 0x00FF00; break; // 綠色
      case "HARD": embedColor = 0xFF8000; break;   // 橘色
      case "CRASH": embedColor = 0xFF0000; break;  // 紅色
      default: embedColor = 0x0099FF; break;       // 藍色
    }

    const message = {
      embeds: [{
        title: "🛫 Flight Report - GeoFS",
        color: embedColor,
        fields: [
          {
            name: "✈️ Flight Information",
            value: `**Pilot**: ${data.pilot}\n**Aircraft**: ${data.aircraft}`,
            inline: false
          },
          {
            name: "📍 Route",
            value: `**Departure**: ${data.dep}\n**Arrival**: ${data.arr}`,
            inline: true
          },
          {
            name: "⏱️ Duration",
            value: `**Flight Time**: ${data.duration} mins`,
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

    fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message)
    }).then(() => console.log("✅ Flight log sent"))
      .catch(console.error);
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
      departureICAO = nearestAirport.icao;
      departureAirportData = nearestAirport; // 儲存完整的機場資料
      saveSession();
      console.log(`🛫 Departure detected at ${departureICAO}`);
      if (panelUI) {
        panelUI.style.opacity = "0";
        setTimeout(() => panelUI.style.display = "none", 500);
      }
    }

    const elapsed = (now - flightStartTime) / 1000;
    if (flightStarted && !firstGroundContact && onGround) {
      if (elapsed < 1) return;
      const vs = values.verticalSpeed;
      if (vs <= -800) {
        alert("⚠️ CRASH DETECTED: Logging crash report.");
        arrivalICAO = "Crash";
        arrivalAirportData = null;
      } else {
        const nearestAirport = getNearestAirport(lat, lon);
        arrivalICAO = nearestAirport.icao;
        arrivalAirportData = nearestAirport; // 儲存完整的機場資料
      }
      console.log(`🛬 Arrival detected at ${arrivalICAO}`);
      firstGroundContact = true;
      firstGroundTime = now;

      const g = (values.accZ / 9.80665).toFixed(2);
      const gs = values.groundSpeedKnt.toFixed(1);
      const tas = geofs.aircraft.instance.trueAirSpeed?.toFixed(1) || "N/A";
      const quality = (vs > -60) ? "BUTTER" : (vs > -800) ? "HARD" : "CRASH";
      const pilot = callsignInput.value.trim() || "Unknown";
      const aircraft = aircraftInput.value.trim() || "Unknown";
      const durationMin = Math.round((firstGroundTime - flightStartTime) / 60000);

      sendLogToDiscord({
        pilot, aircraft,
        takeoff: flightStartTime,
        landing: firstGroundTime,
        dep: departureICAO,
        arr: arrivalICAO,
        duration: durationMin,
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
      panelUI.style.display = "block";
      panelUI.style.opacity = "0.5";
    }
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
      zIndex: "9999",
      width: "220px",
      fontSize: "14px",
      fontFamily: "sans-serif",
      transition: "opacity 0.5s ease",
      display: "block", // 預設顯示
      opacity: "0.5" // ← 新增透明度
    });

    callsignInput = document.createElement("input");
    callsignInput.placeholder = "Callsign";
    callsignInput.style.width = "100%";
    callsignInput.style.marginBottom = "6px";
    disableKeyPropagation(callsignInput);
    callsignInput.onkeyup = () => {
      startButton.disabled = callsignInput.value.trim() === "";
    };

    aircraftInput = document.createElement("input");
    aircraftInput.placeholder = "Aircraft Type (A320, B737, etc)";
    aircraftInput.style.width = "100%";
    aircraftInput.style.marginBottom = "6px";
    disableKeyPropagation(aircraftInput);

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
    panelUI.appendChild(aircraftInput);
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
        if (panelUI) {
          panelUI.style.opacity = "0";
          setTimeout(() => panelUI.style.display = "none", 500);
        }
      } else {
        alert("❌ No previous session found.");
      }
    };

    panelUI.appendChild(resumeBtn);
    document.body.appendChild(panelUI);
  }

  window.addEventListener("load", () => {
    console.log("✅ GeoFS Flight Logger (Auto ICAO, CDN JSON) Loaded");
    createSidePanel();
  });
})();

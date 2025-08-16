// ==UserScript==
// @name         Semi-Automated-Webhook Flight logger
// @namespace    https://your-va.org/flightlogger
// @version      2025-08-07
// @description  Logs flights with crash detection, ICAO input, session recovery & terrain-based AGL check
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

  function saveSession() {
    const session = {
      flightStarted,
      flightStartTime,
      departureICAO,
      callsign: callsignInput?.value.trim() || "Unknown",
      aircraft: aircraftInput?.value.trim() || "Unknown",
      firstGroundContact,
      timestamp: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function loadSession() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function sendLogToDiscord(data) {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: "Europe/London", day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const takeoffTime = fmt.format(new Date(data.takeoff));
    const landingTime = fmt.format(new Date(data.landing));

    const message = {
      content: `🧾 **Flight Report - GeoFS**
**✈️ Flight Number and operator**: ${data.pilot}
**🛩️ Aircraft**: ${data.aircraft}
**📍Departure**: ${data.dep}
**🛬 Arrival**: ${data.arr}
**⏱️ Flight Time**: ${data.duration} mins
**📉 V/S**: ${data.vs} fpm | **G-Force**: ${data.gforce}
**⚙️ TAS**: ${data.ktrue} kts | **GS**: ${data.gs} kts
**🏁 Landing**: ${data.landingQuality}
**🕓 Takeoff Time**: ${takeoffTime} BST
**🕓 Landing Time**: ${landingTime} BST`
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

    const now = Date.now();

    if (!flightStarted && !onGround && agl > 100) {
      flightStarted = true;
      flightStartTime = now;
      departureICAO = prompt("📍 Enter ICAO of departure airport:") || "UNKNOWN";
      saveSession();
      console.log(`🛫 Departure: ${departureICAO}`);
    }

    const elapsed = (now - flightStartTime) / 1000;

    if (flightStarted && !firstGroundContact && onGround) {
      if (elapsed < 1) {
        console.log("⏳ Not enough flight time to log.");
        return;
      }

      const vs = values.verticalSpeed;

      if (vs <= -800) {
        alert("⚠️ CRASH DETECTED: Logging crash report.");
        arrivalICAO = "Crash";
      } else {
        arrivalICAO = prompt("📍 Enter ICAO of arrival airport:") || "UNKNOWN";
      }

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
        pilot,
        aircraft,
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
    callsignInput.value = "";
    aircraftInput.value = "";
    startButton.disabled = true;
    startButton.innerText = "📋 Start Flight Logger";
  }

  function disableKeyPropagation(input) {
    ["keydown", "keyup", "keypress"].forEach(eventType => {
      input.addEventListener(eventType, e => e.stopPropagation());
    });
  }

  function createSidePanel() {
    panelUI = document.createElement("div");
    Object.assign(panelUI.style, {
      position: "absolute",
      top: "10px",
      right: "10px",
      background: "#111",
      color: "white",
      padding: "10px",
      border: "2px solid white",
      zIndex: "9999",
      width: "220px",
      fontSize: "14px",
      fontFamily: "sans-serif"
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
        firstGroundContact = resumeSession.firstGroundContact || false;
        callsignInput.value = resumeSession.callsign || "";
        aircraftInput.value = resumeSession.aircraft || "";
        monitorInterval = setInterval(monitorFlight, 1000);
        resumeBtn.innerText = "✅ Resumed!";
        resumeBtn.disabled = true;
        startButton.innerText = "✅ Logger Running...";
        startButton.disabled = true;
        console.log("🔁 Resumed flight session.");
      } else {
        alert("❌ No previous session found.");
      }
    };

    panelUI.appendChild(resumeBtn);
    document.body.appendChild(panelUI);
  }

  window.addEventListener("load", () => {
    console.log("✅ GeoFS Flight Logger (Terrain Aware) Loaded");
    createSidePanel();
  });
})();

/**
 * Synap Identity Layer (Frontend)
 *
 * Detects corporate environment via Azure AD / MSAL.
 * Silently acquires an access token if available and passes it
 * to the backend for profile enrichment.
 *
 * This script is loaded by the frontend but only activates when
 * identity.environment is "auto" or "corporate" in the config.
 *
 * In public mode, this is a no-op.
 */

(function () {
  "use strict";

  // Exposed globally for synap.js to call
  window.SynapIdentity = {
    detect: detectEnvironment,
    getToken: getAccessToken,
    getProfile: getClientProfile,
  };

  let msalInstance = null;
  let cachedToken = null;

  /**
   * Detect if we're in a corporate environment.
   * Returns "corporate" if MSAL can silently acquire a token, "public" otherwise.
   */
  async function detectEnvironment(identityConfig) {
    if (!identityConfig) return "public";

    const env = identityConfig.environment || "auto";
    if (env === "public") return "public";
    if (env === "corporate") {
      await initMsal(identityConfig);
      return "corporate";
    }

    // Auto-detect: try to load MSAL and silently acquire a token
    if (env === "auto") {
      try {
        await initMsal(identityConfig);
        const token = await silentTokenAcquisition(identityConfig);
        if (token) return "corporate";
      } catch {
        // MSAL not available or silent auth failed
      }
      return "public";
    }

    return "public";
  }

  /**
   * Get an access token for Microsoft Graph (if in corporate mode).
   */
  async function getAccessToken(identityConfig) {
    if (cachedToken) return cachedToken;
    try {
      cachedToken = await silentTokenAcquisition(identityConfig);
      return cachedToken;
    } catch {
      return null;
    }
  }

  /**
   * Get basic profile from the client-side Graph call (lightweight).
   * Falls back to empty if not available.
   */
  async function getClientProfile(identityConfig) {
    const token = await getAccessToken(identityConfig);
    if (!token) return null;

    try {
      const fields = identityConfig?.profile_fields || [
        "displayName", "department", "jobTitle", "officeLocation", "employeeId"
      ];
      const resp = await fetch(
        "https://graph.microsoft.com/v1.0/me?$select=" + fields.join(","),
        { headers: { Authorization: "Bearer " + token } }
      );
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  /**
   * Initialize MSAL.js (loaded from CDN only when needed).
   */
  async function initMsal(identityConfig) {
    if (msalInstance) return;

    if (!identityConfig.msal_client_id || !identityConfig.msal_authority) {
      throw new Error("MSAL requires msal_client_id and msal_authority in identity config");
    }

    // Dynamically load MSAL if not already present
    if (!window.msal) {
      await loadScript("https://alcdn.msauth.net/browser/2.38.3/js/msal-browser.min.js");
    }

    msalInstance = new window.msal.PublicClientApplication({
      auth: {
        clientId: identityConfig.msal_client_id,
        authority: identityConfig.msal_authority,
        redirectUri: identityConfig.msal_redirect_uri || window.location.origin,
      },
      cache: {
        cacheLocation: "sessionStorage",
      },
    });

    await msalInstance.initialize();
  }

  /**
   * Silently acquire an access token for Microsoft Graph.
   */
  async function silentTokenAcquisition(identityConfig) {
    if (!msalInstance) return null;

    const accounts = msalInstance.getAllAccounts();
    if (accounts.length === 0) {
      // Try SSO silent — works if user is already signed in to Azure AD
      try {
        const result = await msalInstance.ssoSilent({
          scopes: ["User.Read"],
        });
        return result.accessToken;
      } catch {
        return null;
      }
    }

    try {
      const result = await msalInstance.acquireTokenSilent({
        scopes: ["User.Read"],
        account: accounts[0],
      });
      return result.accessToken;
    } catch {
      return null;
    }
  }

  /**
   * Dynamically load an external script.
   */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Failed to load: " + src)); };
      document.head.appendChild(s);
    });
  }
})();

#!/usr/bin/env node
import {
  exchangeAuthenticationTicket,
  mask,
  refreshCookie,
  runProcess,
  validateCookie,
} from "./roblox-auth.mjs";

try {
  if (!process.env.GITHUB_ACTIONS) throw new Error("Cookie rotation is only enabled in GitHub Actions");
  if (!process.env.ROBLOSECURITY) throw new Error("ROBLOSECURITY is missing");
  if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN (the SECRET_ROTATION_TOKEN secret) is missing");

  await validateCookie(process.env.ROBLOSECURITY);
  console.log("Roblox authentication succeeded; rotating cookie...");
  const refreshed = await refreshCookie(process.env.ROBLOSECURITY);
  mask(refreshed);
  await validateCookie(refreshed);
  const saveSecret = (value) =>
    runProcess("gh", ["secret", "set", "ROBLOSECURITY", "--repo", process.env.GITHUB_REPOSITORY], {
      input: value,
      env: process.env,
    });

  // Persist immediately: the refresh already invalidated the previous cookie,
  // so the replacement must be saved before attempting any further request.
  await saveSecret(refreshed);
  console.log("Replacement ROBLOSECURITY saved.");

  // Normalization reduces future IP binding, but is best-effort. A rate limit
  // here must not discard the valid cookie that was already stored.
  try {
    const normalized = await exchangeAuthenticationTicket(refreshed);
    mask(normalized);
    await validateCookie(normalized);
    await saveSecret(normalized);
    console.log("ROBLOSECURITY was rotated, normalized, validated, and saved.");
  } catch (error) {
    console.log(`Normalization skipped (${error.message}); the rotated cookie is already stored.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

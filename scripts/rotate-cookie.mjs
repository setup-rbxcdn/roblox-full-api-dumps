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

  // Normalize the stored browser session to the Actions runner before calling
  // the stricter refresh endpoint. Validation alone can succeed even when that
  // endpoint rejects an IP-bound cookie as unauthenticated.
  const runnerCookie = await exchangeAuthenticationTicket(process.env.ROBLOSECURITY);
  mask(runnerCookie);
  await validateCookie(runnerCookie);

  const refreshed = await refreshCookie(runnerCookie);
  mask(refreshed);
  await validateCookie(refreshed);
  const normalized = await exchangeAuthenticationTicket(refreshed);
  mask(normalized);
  await validateCookie(normalized);
  await runProcess("gh", ["secret", "set", "ROBLOSECURITY", "--repo", process.env.GITHUB_REPOSITORY], {
    input: normalized,
    env: process.env,
  });
  console.log("ROBLOSECURITY was rotated, normalized, validated, and saved.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

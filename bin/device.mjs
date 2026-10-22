#!/usr/bin/env node
// Run the device daemon TypeScript entry through tsx so `my-durable-device` works without a build step.
import { register } from "tsx/esm/api";
register();
await import("../apps/dpi-backend/src/main.ts");

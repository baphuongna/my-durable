#!/usr/bin/env node
// Run the hub TypeScript entry through tsx so `my-durable-hub` works without a build step.
import { register } from "tsx/esm/api";
register();
await import("../apps/dpi-playground/apps/dpi-playground-hub/src/main.ts");

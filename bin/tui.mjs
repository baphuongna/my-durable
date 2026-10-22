#!/usr/bin/env node
// Run the TUI TypeScript entry through tsx so `my-durable-tui` works without a build step.
import { register } from "tsx/esm/api";
register();
await import("../apps/dpi-tui/src/main.ts");

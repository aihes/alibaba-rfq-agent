#!/usr/bin/env node
import { testNotification } from "../src/notifications.js";

if (process.argv[2] !== "test") throw new Error("Unsupported notification command");
console.log(JSON.stringify(await testNotification()));

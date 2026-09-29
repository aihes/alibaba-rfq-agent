#!/usr/bin/env node
import { loadConfig, projectDir } from "../src/config.js";
import { reanalyzeDraft } from "../src/reanalyze-draft.js";

const result = await reanalyzeDraft(projectDir, process.argv[2], process.argv[3], loadConfig());
console.log(JSON.stringify(result));

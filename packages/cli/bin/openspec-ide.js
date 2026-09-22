#!/usr/bin/env node
import { run } from '../dist/run.js';

const outcome = await run(process.argv.slice(2));

for (const line of outcome.stdout) console.log(line);
for (const line of outcome.stderr) console.error(line);

if (outcome.code !== 0) process.exit(outcome.code);

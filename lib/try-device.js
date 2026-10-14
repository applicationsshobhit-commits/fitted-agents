// For the Designer: build a device module with given sizes and print what came out.
// Usage: node lib/try-device.js <device.mjs | built-in name> '<params JSON>'
import { buildDesign } from './devices.js';

const [device, json = '{}'] = process.argv.slice(2);
try {
  const r = await buildDesign({ device, params: JSON.parse(json) }, process.cwd());
  console.log(JSON.stringify({ params: r.params, ...r.report, problems: r.problems }, null, 2));
  process.exit(r.problems.length ? 2 : 0);
} catch (err) {
  console.error(`build failed: ${err.stack || err}`);
  process.exit(1);
}

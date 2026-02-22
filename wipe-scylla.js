#!/usr/bin/env node
require('dotenv').config();
const readline = require('node:readline');
const { Client, auth } = require('cassandra-driver');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    mode: 'drop',
    force: false,
    recreate: false,
    replication: null,
    keyspace: null,
    includeSystem: false
  };
  
  // Show help if requested
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
ScyllaDB Keyspace Management Tool

Usage: node wipe-scylla.js [options]

Modes:
  --mode=drop      Drop the entire keyspace(s) (default)
  --mode=truncate  Truncate all tables in the keyspace(s)
  --mode=read      Read and display all data in the keyspace(s)

Options:
  --keyspace=NAME     Specify keyspace directly (single keyspace only)
  --force            Skip confirmation prompts
  --recreate         Recreate keyspace after dropping (only with --mode=drop)
  --replication=N    Replication factor for recreate (default: 3)
  --include-system   Include system keyspaces in selection
  --help, -h         Show this help message

Selection Examples (when prompted):
  1                 Select keyspace #1
  2-4               Select keyspaces #2, #3, and #4
  1,3,5             Select keyspaces #1, #3, and #5
  2-3,5-7           Select keyspaces #2, #3, #5, #6, and #7
  1,3-5,8           Select keyspaces #1, #3, #4, #5, and #8

Command Examples:
  node wipe-scylla.js --mode=read
  node wipe-scylla.js --mode=read --keyspace=my_keyspace
  node wipe-scylla.js --mode=drop --force --recreate
  node wipe-scylla.js --mode=truncate --keyspace=test_data
`);
    process.exit(0);
  }
  for (const a of args) {
    if (a.startsWith('--mode=')) opts.mode = a.split('=')[1];
    else if (a.startsWith('--keyspace=')) opts.keyspace = a.split('=')[1];
    else if (a === '--force') opts.force = true;
    else if (a === '--recreate') opts.recreate = true;
    else if (a.startsWith('--replication=')) opts.replication = Number(a.split('=')[1]);
    else if (a === '--include-system') opts.includeSystem = true;
    else console.warn(`Unknown arg: ${a}`);
  }
  if (!['drop', 'truncate', 'read'].includes(opts.mode)) {
    console.error('Invalid --mode. Use "drop" (default), "truncate", or "read".');
    process.exit(2);
  }
  return opts;
}

function getEnv(name, required = true, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  if (required && (!v || !String(v).trim())) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

function rlAsk(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (ans) => { rl.close(); res(ans.trim()); }));
}

async function confirmOrExit(message, force) {
  if (force) return;
  const ans = await rlAsk(`${message} Type "YES" to proceed: `);
  if (ans !== 'YES') {
    console.log('Aborted.');
    process.exit(0);
  }
}

function buildClient() {
  const contactPoints = getEnv('SCYLLA_CONTACT_POINTS').split(',').map(s => s.trim()).filter(Boolean);
  const localDataCenter = getEnv('SCYLLA_LOCAL_DATACENTER');
  const username = getEnv('SCYLLA_USERNAME');
  const password = getEnv('SCYLLA_PASSWORD');
  const authProvider = new auth.PlainTextAuthProvider(username, password);

  return new Client({
    contactPoints,
    localDataCenter,
    authProvider,
    queryOptions: { consistency: 1 },
  });
}

async function fetchKeyspaces(client, includeSystem) {
  const rs = await client.execute('SELECT keyspace_name FROM system_schema.keyspaces');
  let ks = rs.rows.map(r => r['keyspace_name']).sort((a, b) => a.localeCompare(b));
  if (!includeSystem) {
    ks = ks.filter(k => !k.startsWith('system') && !k.startsWith('virtual'));
  }
  return ks;
}

async function pickKeyspaceInteractive(client, includeSystem, suggested) {
  const ks = await fetchKeyspaces(client, includeSystem);
  if (ks.length === 0) {
    console.error('No keyspaces found to choose from.');
    process.exit(2);
  }

  console.log('\nAvailable keyspaces:');
  ks.forEach((k, i) => {
    const mark = suggested && suggested === k ? ' (default from .env)' : '';
    console.log(`${String(i + 1).padStart(2, ' ')}. ${k}${mark}`);
  });

  const defIndex = suggested ? ks.indexOf(suggested) : -1;
  const prompt = defIndex >= 0
    ? `\nSelect keyspace(s) by number (1-${ks.length}) [default ${defIndex + 1}]: `
    : `\nSelect keyspace(s) by number (1-${ks.length}): `;

  while (true) {
    const ans = await rlAsk(prompt);
    if (!ans && defIndex >= 0) return [ks[defIndex]];
    
    // Parse the input to support ranges and multiple selections
    const selected = parseSelection(ans, ks.length);
    if (selected.length > 0) {
      return selected.map(i => ks[i - 1]);
    }
    
    console.log(`Please enter valid numbers between 1 and ${ks.length}. Examples: 1, 2-4, 1,3,5, 2-3,5-7`);
  }
}

function parseSelection(input, maxNum) {
  if (!input || !input.trim()) return [];
  
  const selections = [];
  const parts = input.split(',').map(s => s.trim());
  
  for (const part of parts) {
    if (part.includes('-')) {
      // Handle range (e.g., "2-4")
      const [start, end] = part.split('-').map(s => s.trim());
      const startNum = Number(start);
      const endNum = Number(end);
      
      if (!Number.isInteger(startNum) || !Number.isInteger(endNum)) {
        console.log(`Invalid range: ${part}. Use format like "2-4"`);
        return [];
      }
      
      if (startNum < 1 || endNum > maxNum || startNum > endNum) {
        console.log(`Range ${part} is out of bounds (1-${maxNum}) or invalid`);
        return [];
      }
      
      // Add all numbers in the range
      for (let i = startNum; i <= endNum; i++) {
        if (!selections.includes(i)) {
          selections.push(i);
        }
      }
    } else {
      // Handle single number
      const num = Number(part);
      if (!Number.isInteger(num) || num < 1 || num > maxNum) {
        console.log(`Invalid number: ${part}. Must be between 1 and ${maxNum}`);
        return [];
      }
      
      if (!selections.includes(num)) {
        selections.push(num);
      }
    }
  }
  
  return selections.sort((a, b) => a - b);
}

async function dropKeyspace(client, keyspaces) {
  const keyspaceList = Array.isArray(keyspaces) ? keyspaces : [keyspaces];
  
  for (const keyspace of keyspaceList) {
    console.log(`Dropping keyspace "${keyspace}"...`);
    await client.execute(`DROP KEYSPACE IF EXISTS "${keyspace}";`);
    console.log(`Keyspace "${keyspace}" dropped.`);
  }
}

async function recreateKeyspace(client, keyspaces, dc, rf) {
  const keyspaceList = Array.isArray(keyspaces) ? keyspaces : [keyspaces];
  const replication = `{'class': 'NetworkTopologyStrategy', '${dc}': ${rf}}`;
  
  for (const keyspace of keyspaceList) {
    console.log(`Recreating keyspace "${keyspace}" with replication ${replication}...`);
    await client.execute(
      `CREATE KEYSPACE IF NOT EXISTS "${keyspace}" WITH replication = ${replication};`
    );
    console.log(`Keyspace "${keyspace}" recreated.`);
  }
}

async function truncateAllTables(client, keyspaces) {
  const keyspaceList = Array.isArray(keyspaces) ? keyspaces : [keyspaces];
  
  for (const keyspace of keyspaceList) {
    console.log(`\nTruncating tables in keyspace "${keyspace}"...`);
    const rs = await client.execute(
      'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?',
      [keyspace],
      { prepare: true }
    );
    const tables = rs.rows.map(r => r['table_name']);
    if (tables.length === 0) {
      console.log(`No tables found in keyspace "${keyspace}".`);
      continue;
    }
    console.log(`Truncating ${tables.length} table(s): ${tables.join(', ')}`);
    for (const t of tables) {
      const fq = `"${keyspace}"."${t}"`;
      process.stdout.write(`  TRUNCATE ${fq} ... `);
      await client.execute(`TRUNCATE ${fq};`);
      console.log('OK');
    }
  }
}

async function readAllData(client, keyspaces) {
  const keyspaceList = Array.isArray(keyspaces) ? keyspaces : [keyspaces];
  
  for (const keyspace of keyspaceList) {
    console.log(`\n📖 Reading all data from keyspace "${keyspace}"...\n`);
    
    // Get all tables in the keyspace
    const rs = await client.execute(
      'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?',
      [keyspace],
      { prepare: true }
    );
    const tables = rs.rows.map(r => r['table_name']);
    
    if (tables.length === 0) {
      console.log(`No tables found in keyspace "${keyspace}".`);
      continue;
    }
    
    console.log(`Found ${tables.length} table(s): ${tables.join(', ')}\n`);
    
    for (const table of tables) {
      console.log(`\n📋 Table: ${keyspace}.${table}`);
      console.log('='.repeat(50));
      
      try {
        // Get table schema to understand column structure
        const schemaRs = await client.execute(
          'SELECT column_name, type FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
          [keyspace, table],
          { prepare: true }
        );
        
        const columns = schemaRs.rows.map(r => ({ name: r['column_name'], type: r['type'] }));
        console.log(`Columns: ${columns.map(c => `${c.name} (${c.type})`).join(', ')}`);
        
        // Read all data from the table
        const dataRs = await client.execute(`SELECT * FROM "${keyspace}"."${table}"`);
        
        if (dataRs.rows.length === 0) {
          console.log('  (No data)');
          continue;
        }
        
        console.log(`\n  Rows: ${dataRs.rows.length}`);
        
        // Display data in a readable format
        dataRs.rows.forEach((row, index) => {
          console.log(`\n  Row ${index + 1}:`);
          columns.forEach(col => {
            const value = row[col.name];
            let displayValue;
            
            if (value === null || value === undefined) {
              displayValue = 'null';
            } else if (typeof value === 'object' && value.constructor && value.constructor.name === 'Date') {
              displayValue = value.toISOString();
            } else if (typeof value === 'object') {
              displayValue = JSON.stringify(value);
            } else {
              displayValue = String(value);
            }
            
            // Truncate very long values for readability
            if (displayValue.length > 100) {
              displayValue = displayValue.substring(0, 97) + '...';
            }
            
            console.log(`    ${col.name}: ${displayValue}`);
          });
        });
        
      } catch (error) {
        console.error(`  ❌ Error reading table ${keyspace}.${table}: ${error.message}`);
      }
    }
    
    console.log(`\n✅ Finished reading data from keyspace "${keyspace}"`);
  }
}

(async function main() {
  const opts = parseArgs();
  const envDefaultKeyspace = getEnv('SCYLLA_KEYSPACE', false, '').trim() || null;
  const dc = getEnv('SCYLLA_LOCAL_DATACENTER');
  const rf = Number(opts.replication || 3);

  const client = buildClient();

  try {
    await client.connect();
    console.log('Connected to Scylla.');

    let keyspaces = opts.keyspace ? [opts.keyspace] : null;
    if (!keyspaces) {
      keyspaces = await pickKeyspaceInteractive(client, opts.includeSystem, envDefaultKeyspace);
    }

    const keyspaceList = Array.isArray(keyspaces) ? keyspaces : [keyspaces];
    const keyspaceNames = keyspaceList.join('", "');

    if (opts.mode === 'drop') {
      await confirmOrExit(
        `This will DROP the entire keyspace(s) "${keyspaceNames}" (all data & schema).`,
        opts.force
      );
      await dropKeyspace(client, keyspaceList);
      if (opts.recreate) {
        await recreateKeyspace(client, keyspaceList, dc, rf);
      }
    } else if (opts.mode === 'truncate') {
      await confirmOrExit(
        `This will TRUNCATE ALL TABLES in keyspace(s) "${keyspaceNames}" (data only).`,
        opts.force
      );
      await truncateAllTables(client, keyspaceList);
    } else if (opts.mode === 'read') {
      // No confirmation needed for read mode - it's safe
      await readAllData(client, keyspaceList);
    }

    console.log('Done.');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await client.shutdown().catch(() => {});
  }
})();

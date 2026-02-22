#!/usr/bin/env node

/**
 * Migration script to add is_active column to user tables
 * Run this if you need to manually add the column to existing tables
 */

const { Client } = require('cassandra-driver');

async function migrate() {
  const client = new Client({
    contactPoints: [process.env.SCYLLA_CONTACT_POINTS || 'localhost'],
    localDataCenter: process.env.SCYLLA_LOCAL_DATACENTER || 'datacenter1',
    keyspace: process.env.SCYLLA_KEYSPACE || 'default',
    username: process.env.SCYLLA_USERNAME,
    password: process.env.SCYLLA_PASSWORD,
  });

  try {
    await client.connect();
    console.log('✅ Connected to database');

    // Add is_active column to users_by_gryt_id
    try {
      await client.execute(`ALTER TABLE users_by_gryt_id ADD is_active boolean`);
      console.log('✅ Added is_active column to users_by_gryt_id table');
    } catch (error) {
      if (error.message.includes('already exists') || error.message.includes('Invalid column name')) {
        console.log('ℹ️ is_active column already exists in users_by_gryt_id table');
      } else {
        console.error('❌ Failed to add is_active column to users_by_gryt_id:', error.message);
      }
    }

    // Add is_active column to users_by_server_id
    try {
      await client.execute(`ALTER TABLE users_by_server_id ADD is_active boolean`);
      console.log('✅ Added is_active column to users_by_server_id table');
    } catch (error) {
      if (error.message.includes('already exists') || error.message.includes('Invalid column name')) {
        console.log('ℹ️ is_active column already exists in users_by_server_id table');
      } else {
        console.error('❌ Failed to add is_active column to users_by_server_id:', error.message);
      }
    }

    // Set default value for existing users
    // Note: We can't use WHERE is_active = null in Cassandra, so we'll update all rows
    try {
      // Get all existing users and update them
      const grytUsers = await client.execute(`SELECT gryt_user_id FROM users_by_gryt_id`);
      const serverUsers = await client.execute(`SELECT server_user_id FROM users_by_server_id`);
      
      // Update users_by_gryt_id
      for (const row of grytUsers.rows) {
        await client.execute(
          `UPDATE users_by_gryt_id SET is_active = true WHERE gryt_user_id = ?`,
          [row.gryt_user_id],
          { prepare: true }
        );
      }
      
      // Update users_by_server_id
      for (const row of serverUsers.rows) {
        await client.execute(
          `UPDATE users_by_server_id SET is_active = true WHERE server_user_id = ?`,
          [row.server_user_id],
          { prepare: true }
        );
      }
      
      console.log(`✅ Set default is_active = true for ${grytUsers.rows.length} users in users_by_gryt_id and ${serverUsers.rows.length} users in users_by_server_id`);
    } catch (error) {
      console.error('❌ Failed to set default is_active values:', error.message);
    }

    console.log('🎉 Migration completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await client.shutdown();
  }
}

migrate();

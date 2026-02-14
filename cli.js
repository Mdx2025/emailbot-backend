#!/usr/bin/env node

/**
 * EmailBot CLI
 * Command line interface for EmailBot operations
 */

const { Command } = require('commander');
const EmailBot = require('./src/index');

const program = new Command();
const emailbot = new EmailBot();

program
  .name('emailbot')
  .description('EmailBot - Automated lead processing system')
  .version('2.0.0');

// Ingest command
program
  .command('ingest')
  .description('Process new emails and generate drafts')
  .option('--filter <query>', 'Gmail search query', 'subject:"Nuevo cliente potencial"')
  .option('--limit <number>', 'Max emails to process', '10')
  .action(async (options) => {
    try {
      const result = await emailbot.ingest(options);
      console.log(`✅ Processed ${result.processed.length} emails`);
      result.processed.forEach(e => {
        console.log(`   - ${e.email} (${e.company || 'N/A'})`);
      });
    } catch (error) {
      console.error('❌ Ingestion failed:', error.message);
      process.exit(1);
    }
  });

// List command
program
  .command('list')
  .description('List drafts by status')
  .argument('[status]', 'Status filter', 'pending_review')
  .action(async (status) => {
    try {
      const drafts = await emailbot.listDrafts(status);
      console.log(`\n📋 ${status.toUpperCase()} (${drafts.length})\n`);
      
      if (drafts.length === 0) {
        console.log('   No drafts found');
      }
      
      for (const d of drafts) {
        console.log(`   ${d.id.substring(0, 8)} | ${d.client.email} | ${d.client.company || 'N/A'}`);
        console.log(`   Generated: ${new Date(d.generatedAt).toLocaleString()}`);
        console.log('');
      }
    } catch (error) {
      console.error('❌ Failed to list drafts:', error.message);
      process.exit(1);
    }
  });

// Show command
program
  .command('show')
  .description('Show draft details')
  .argument('<draftId>')
  .action(async (draftId) => {
    try {
      const draft = await emailbot.approver.get(draftId);
      
      if (!draft) {
        console.error('❌ Draft not found');
        process.exit(1);
      }

      console.log('\n📧 DRAFT DETAILS\n');
      console.log(`ID: ${draft.id}`);
      console.log(`Status: ${draft.status}`);
      console.log(`Client: ${draft.client.name} (${draft.client.email})`);
      console.log(`Company: ${draft.client.company || 'N/A'}`);
      console.log(`Service: ${draft.client.service || 'N/A'}`);
      console.log(`Generated: ${new Date(draft.generatedAt).toLocaleString()}`);
      console.log('\n--- DRAFT CONTENT ---\n');
      console.log(draft.draft);
      console.log('\n---------------------\n');

    } catch (error) {
      console.error('❌ Failed to show draft:', error.message);
      process.exit(1);
    }
  });

// Approve command
program
  .command('approve')
  .description('Approve a draft')
  .argument('<draftId>')
  .option('--edit <message>', 'Edit the draft before sending')
  .action(async (draftId, options) => {
    try {
      const draft = await emailbot.approve(draftId, options);
      console.log(`✅ Draft approved: ${draftId}`);
      if (options.edit) {
        console.log('   (with edits applied)');
      }
    } catch (error) {
      console.error('❌ Approval failed:', error.message);
      process.exit(1);
    }
  });

// Reject command
program
  .command('reject')
  .description('Reject a draft')
  .argument('<draftId>')
  .argument('<reason>')
  .action(async (draftId, reason) => {
    try {
      await emailbot.reject(draftId, reason);
      console.log(`❌ Draft rejected: ${draftId}`);
      console.log(`   Reason: ${reason}`);
    } catch (error) {
      console.error('❌ Rejection failed:', error.message);
      process.exit(1);
    }
  });

// Send command
program
  .command('send')
  .description('Send approved drafts')
  .argument('[status]', 'Drafts to send', 'approved')
  .action(async (status) => {
    try {
      if (status !== 'pending' && status !== 'approved') {
        console.log('Sending only approved drafts. Use "emailbot list approved" to see pending.');
      }
      
      const results = await emailbot.sendApproved();
      console.log(`\n📤 SENDING COMPLETE\n`);
      console.log(`   Sent: ${results.sent}`);
      console.log(`   Failed: ${results.failed}`);
      
      if (results.details.length > 0) {
        console.log('\n   Details:');
        results.details.forEach(d => {
          console.log(`   - ${d.email}: ${d.status}`);
        });
      }
    } catch (error) {
      console.error('❌ Send failed:', error.message);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show system status and statistics')
  .action(async () => {
    try {
      const status = await emailbot.getStatus();
      console.log('\n📊 EMAILBOT STATUS\n');
      console.log(`   Drafts Total: ${status.stats.total}`);
      console.log(`   Pending Review: ${status.stats.pending}`);
      console.log(`   Approved: ${status.stats.approved}`);
      console.log(`   Rejected: ${status.stats.rejected}`);
      console.log(`   Sent: ${status.stats.sent}`);
      console.log('\n   Last Run:', status.lastRun || 'Never');
    } catch (error) {
      console.error('❌ Status failed:', error.message);
      process.exit(1);
    }
  });

// Stats command
program
  .command('stats')
  .description('Show detailed statistics')
  .action(async () => {
    try {
      const status = await emailbot.getStatus();
      console.log('\n📈 EMAILBOT STATISTICS\n');
      console.log(JSON.stringify(status, null, 2));
    } catch (error) {
      console.error('❌ Stats failed:', error.message);
      process.exit(1);
    }
  });

// Sync command
program
  .command('sync')
  .description('Sync with Notion CRM')
  .action(async () => {
    try {
      console.log('🔄 Syncing with Notion...');
      const result = await emailbot.syncNotion();
      console.log(`✅ Sync complete: ${result.updated} updated`);
    } catch (error) {
      console.error('❌ Sync failed:', error.message);
      process.exit(1);
    }
  });

// Followup command
program
  .command('followup')
  .description('Generate follow-up draft')
  .argument('<threadId>')
  .argument('<number>', 'Follow-up number (1, 2, or 3)')
  .action(async (threadId, number) => {
    try {
      const draft = await emailbot.generateFollowup(threadId, parseInt(number));
      console.log(`✅ Follow-up ${number} generated: ${draft.id}`);
    } catch (error) {
      console.error('❌ Follow-up failed:', error.message);
      process.exit(1);
    }
  });

// Parse and execute
program.parse();

module.exports = program;

const readline = require('node:readline/promises');

async function chooseResultMode(args, { interactive = Boolean(process.stdin.isTTY), ask } = {}) {
  if (args.length > 1 || args.some(a => !['--keep','--fresh','--choose'].includes(a))) {
    throw Error('Usage: npm start -- [--keep | --fresh | --choose]');
  }
  if (args[0] === '--keep') return 'keep';
  if (args[0] === '--fresh') return 'fresh';
  if (!interactive && args[0] !== '--choose') return 'keep';
  console.log('\nChoose the results for this run:');
  console.log('  1. Keep previous results and add new invoices (default)');
  console.log('  2. New results only - back up and clear previous results');
  console.log('  3. Cancel');
  console.log('Downloaded PDFs are retained. Both options continue from the last successful email run.\n');
  const prompt = ask ? null : readline.createInterface({ input:process.stdin, output:process.stdout });
  try {
    while (true) {
      const value = String(await (ask ? ask('Select [1/2/3], Enter for 1: ') : prompt.question('Select [1/2/3], Enter for 1: '))).trim();
      if (!value || value === '1') return 'keep';
      if (value === '2') return 'fresh';
      if (value === '3') return 'cancel';
      console.log('Enter 1, 2 or 3.');
    }
  } finally { prompt?.close(); }
}
module.exports = { chooseResultMode };

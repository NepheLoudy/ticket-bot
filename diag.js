const { Client } = require('ssh2');
const conn = new Client();

const commands = [
  'echo "===== 含[多维表格]的日志 ====="; grep -n "多维表格" /home/qianli/.pm2/logs/ticket-bot-out.log | tail -20; echo "---错误日志---"; grep -n "多维表格\|bitable\|事件" /home/qianli/.pm2/logs/ticket-bot-error.log | tail -20',
  'echo "===== 最近30行out日志 ====="; tail -30 /home/qianli/.pm2/logs/ticket-bot-out.log',
  'echo "===== 最近20行error日志 ====="; tail -20 /home/qianli/.pm2/logs/ticket-bot-error.log',
];

conn.on('ready', () => {
  console.log('SSH OK\n');
  execNext(0);
});

function execNext(i) {
  if (i >= commands.length) { conn.end(); return; }
  const cmd = commands[i];
  console.log('\n$ ' + cmd + '\n');
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('执行失败:', err.message); conn.end(); return; }
    stream.on('data', (d) => process.stdout.write(d.toString()));
    stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
    stream.on('close', () => execNext(i + 1));
  });
}

conn.on('error', (e) => { console.error('SSH失败:', e.message); process.exit(1); });
conn.on('end', () => console.log('\nSSH关闭'));

console.log('连接 NAS...');
conn.connect({ host: '10.253.33.233', port: 8500, username: 'qianli', password: 'cquqianli2026' });

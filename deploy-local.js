const { Client } = require('ssh2');

const config = {
  host: '10.253.33.233',
  port: 8500,
  username: 'qianli',
  password: 'cquqianli2026'
};

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH连接成功！');

  const commands = [
    { cmd: 'pm2 logs ticket-bot --lines 50 --nostream' },
    { cmd: 'curl -s http://localhost:3003/api/health' },
    { cmd: 'curl -s http://localhost:3003/api/bot/cron-status' }
  ];

  executeCommands(commands, 0, () => {
    conn.end();
  });
});

function executeCommands(commands, index, onComplete) {
  if (index >= commands.length) {
    if (onComplete) onComplete();
    return;
  }

  const cmd = commands[index];
  console.log(`\n[${index + 1}/${commands.length}] 执行: ${cmd.cmd}`);

  conn.exec(cmd.cmd, (err, stream) => {
    if (err) {
      console.error('命令执行失败:', err.message);
      conn.end();
      return;
    }

    let stdout = '';
    let stderr = '';

    stream.on('data', (data) => {
      stdout += data.toString();
    });

    stream.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    stream.on('close', (code) => {
      if (stdout.trim()) {
        console.log(stdout.trim());
      }
      if (stderr.trim()) {
        console.error('错误:', stderr.trim());
      }

      if (code === 0) {
        console.log(`命令执行成功 (退出码: ${code})`);
        executeCommands(commands, index + 1, onComplete);
      } else {
        console.error(`命令执行失败 (退出码: ${code})`);
        conn.end();
      }
    });
  });
}

conn.on('error', (err) => {
  console.error('SSH连接失败:', err.message);
  process.exit(1);
});

conn.on('end', () => {
  console.log('SSH连接已关闭');
});

console.log('正在连接到 NAS...');
conn.connect(config);

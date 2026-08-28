const { handleRecordUpdate } = require('./src/services/ticketService');

const recordId = process.argv[2] || 'recvtBThPUIbMK';

console.log(`手动触发工单播报: ${recordId}\n`);

handleRecordUpdate(recordId)
  .then((r) => {
    console.log('\n处理完成:', JSON.stringify(r, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error('\n处理失败:', e.message);
    process.exit(1);
  });

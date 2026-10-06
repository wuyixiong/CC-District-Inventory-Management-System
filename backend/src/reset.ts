/** 清空台账（保留库位与阈值设置）。npm run reset -- --all 连库位/阈值一并恢复默认。 */
import fs from 'node:fs'
import { DATA_DIR, ledgerPath, readLocations, writeLocations, writeSettings, DEFAULT_SETTINGS } from './store'

const all = process.argv.includes('--all')
const ledger = ledgerPath()
if (fs.existsSync(ledger)) {
  fs.unlinkSync(ledger)
  console.log('已清空快照台账。')
} else {
  console.log('台账本来就是空的。')
}
if (all) {
  writeLocations([])
  writeSettings({ ...DEFAULT_SETTINGS })
  console.log('已一并清空库位登记并恢复默认阈值。')
}
console.log(`数据目录: ${DATA_DIR}`)

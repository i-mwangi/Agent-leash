import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './model';
interface PaymentRow { tx_id:string; payload_hash:string; resource:string; response:string|null; created:number }
export interface SpendRow { tx_id:string; asset:string; amount:string; day:string; status:string; recorded:number }
/** Single-machine durable coordination. Share one DB for all local agent processes. */
export class Store {
  readonly db:DatabaseSync;
  constructor(path:string) {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS payments(tx_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,resource TEXT NOT NULL,response TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spends(tx_id TEXT PRIMARY KEY,asset TEXT NOT NULL,amount TEXT NOT NULL,day TEXT NOT NULL,status TEXT NOT NULL,recorded INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS operations(name TEXT PRIMARY KEY,tx_id TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY,created INTEGER NOT NULL);
    `);
  }
  close(){this.db.close();}
  claimPayment(txId:string,hash:string,resource:string) {
    const insert=this.db.prepare('INSERT OR IGNORE INTO payments(tx_id,payload_hash,resource,created) VALUES(?,?,?,?)').run(txId,hash,resource,Date.now());
    const row=this.db.prepare('SELECT * FROM payments WHERE tx_id=?').get(txId) as unknown as PaymentRow;
    if(row.payload_hash!==hash || row.resource!==resource) throw new AppError('PAYMENT_REPLAY',409);
    return {fresh:Number(insert.changes)===1,response:row.response?JSON.parse(row.response):null};
  }
  finishPayment(txId:string,response:unknown) { this.db.prepare('UPDATE payments SET response=? WHERE tx_id=?').run(JSON.stringify(response),txId); }
  async exclusive<T>(name:string,action:()=>Promise<T>) {
    const insert=this.db.prepare('INSERT OR IGNORE INTO locks(name,created) VALUES(?,?)').run(name,Date.now());
    if(!insert.changes) throw new AppError('OPERATION_IN_PROGRESS',409);
    try{return await action();}finally{this.db.prepare('DELETE FROM locks WHERE name=?').run(name);}
  }
  operation(name:string) { return this.db.prepare('SELECT * FROM operations WHERE name=?').get(name) as {name:string;tx_id:string;result:string|null}|undefined; }
  beginOperation(name:string,txId:string) {this.db.prepare('INSERT INTO operations(name,tx_id) VALUES(?,?)').run(name,txId);}
  endOperation(name:string,result:unknown){this.db.prepare('UPDATE operations SET result=? WHERE name=?').run(JSON.stringify(result),name);}
  removeOperation(name:string,txId:string){this.db.prepare('DELETE FROM operations WHERE name=? AND tx_id=? AND result IS NULL').run(name,txId);}
  reserve(txId:string,asset:string,amount:bigint,day:string) { this.db.prepare("INSERT INTO spends(tx_id,asset,amount,day,status) VALUES(?,?,?,?,'pending')").run(txId,asset,amount.toString(),day); }
  spends(){return this.db.prepare('SELECT * FROM spends').all() as unknown as SpendRow[];}
  updateSpend(txId:string,status:'pending'|'success'|'failed',recorded=false){this.db.prepare('UPDATE spends SET status=?,recorded=? WHERE tx_id=?').run(status,recorded?1:0,txId);}
  outstanding(asset:string,confirmed:Set<string>) {
    // Pending from earlier days remains reserved until authoritative reconciliation.
    return this.spends().filter(s=>s.asset===asset && s.status!=='failed' && !confirmed.has(s.tx_id)).reduce((sum,s)=>sum+BigInt(s.amount),0n);
  }
}

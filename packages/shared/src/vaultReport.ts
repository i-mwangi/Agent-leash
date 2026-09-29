import { Interface } from 'ethers';
import { z } from 'zod';
import { address, entityId, uint } from './model';

export const vaultReadAbi=new Interface(['function guardian() view returns(address)','function agent() view returns(address)','function paused() view returns(bool)','function maxPerTx() view returns(uint256)','function maxPerDay() view returns(uint256)','function agreementHash() view returns(bytes32)','function recipients() view returns(address[])','function spentByUtcDay(uint256) view returns(uint256)']);
export const vaultReportSchema=z.object({
  contractId:entityId,contractAddress:address,guardian:address,agent:address,paused:z.boolean(),
  termsHash:z.string().regex(/^0x[\da-fA-F]{64}$/),maxPerTxTinybars:uint,maxPerUtcDayTinybars:uint,
  allowedRecipients:z.array(address).min(1).max(20),balanceTinybars:uint,spentTodayTinybars:uint,utcDay:uint,
}).strict();
export type VaultReport=z.infer<typeof vaultReportSchema>;
export const VAULT_STANDING_FIELDS=[
  {name:'contractId',type:'string'},{name:'contractAddress',type:'address'},{name:'guardian',type:'address'},
  {name:'agent',type:'address'},{name:'paused',type:'bool'},{name:'termsHash',type:'bytes32'},
  {name:'maxPerTxTinybars',type:'uint256'},{name:'maxPerUtcDayTinybars',type:'uint256'},
  {name:'allowedRecipients',type:'address[]'},{name:'balanceTinybars',type:'uint256'},
  {name:'spentTodayTinybars',type:'uint256'},{name:'utcDay',type:'uint256'},
];

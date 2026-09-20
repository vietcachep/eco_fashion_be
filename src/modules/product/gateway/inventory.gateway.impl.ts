import { Injectable } from '@nestjs/common';
import type { InventoryGateway, StockLine } from '@common/gateway/inventory.gateway';
import type { Tx } from '@common/prisma/types';
import { InventoryService } from '../inventory/service/inventory.service';

/* Cài InventoryGateway — uỷ quyền sang InventoryService (khoá dòng + sổ kho). */
@Injectable()
export class InventoryGatewayImpl implements InventoryGateway {
  constructor(private readonly inventory: InventoryService) {}

  availableOf(variantIds: string[]): Promise<Map<string, number>> {
    return this.inventory.availableOf(variantIds);
  }

  reserve(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void> {
    return this.inventory.reserve(lines, ref, tx);
  }

  release(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void> {
    return this.inventory.release(lines, ref, tx);
  }

  commit(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void> {
    return this.inventory.commit(lines, ref, tx);
  }

  restock(lines: StockLine[], ref: { type: string; id: string }, tx: Tx): Promise<void> {
    return this.inventory.restock(lines, ref, tx);
  }
}

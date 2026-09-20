import { AddressResponse } from '../dto/address.response';
import type { AddressRow } from '../repository/address.repository';

export function toAddressResponse(a: AddressRow): AddressResponse {
  return {
    id: a.id,
    recipientName: a.recipientName,
    phone: a.phone,
    provinceCode: a.provinceCode,
    provinceName: a.provinceName,
    districtName: a.districtName,
    wardName: a.wardName,
    street: a.street,
    isDefault: a.isDefault,
    note: a.note,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/*
 * Danh sách ngành gốc cho seeder (`../../marketplace.seed.ts`) và bộ kiểm tra (`../validate.ts`).
 * Thêm ngành mới: tạo `dept/<slug>.ts` + thêm một dòng import/mảng ở đây + thêm slug vào `DEPT_SLUGS` (shops.ts).
 */
import type { DeptSeed } from '../types';
import dienThoai from './dien-thoai-phu-kien';
import mayTinh from './may-tinh-thiet-bi-dien-tu';
import nhaCua from './nha-cua-doi-song';
import sacDep from './sac-dep-suc-khoe';
import giayTui from './giay-dep-tui-xach';
import dongHo from './dong-ho-phu-kien';
import theThao from './the-thao-da-ngoai';
import meBe from './me-be';
import sach from './sach-van-phong-pham';
import thucPham from './thuc-pham-do-uong';
import thuCung from './thu-cung';
import otoXeMay from './o-to-xe-may';

export const DEPARTMENTS: DeptSeed[] = [dienThoai, mayTinh, nhaCua, sacDep, giayTui, dongHo, theThao, meBe, sach, thucPham, thuCung, otoXeMay];

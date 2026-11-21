/**
 * 虚构归档材料以 Vite ?raw 方式打包进应用，
 * “一键载入示例归档”无需任何网络请求即可使用。
 */
import f01 from '../../sample-archive/01-浙江-采购意向-ZC2024-017.txt?raw';
import f02 from '../../sample-archive/02-浙江-招标公告-ZC2024-017-网页归档.txt?raw';
import f03 from '../../sample-archive/03-浙江-招标公告-ZC2024-017-打印件副本.txt?raw';
import f04 from '../../sample-archive/04-浙江-更正公告-预算变动-ZC2024-017.txt?raw';
import f05 from '../../sample-archive/05-浙江-延期公告-时限调整-ZC2024-017.txt?raw';
import f06 from '../../sample-archive/06-浙江-中标结果-ZC2024-017-附件摘要.txt?raw';
import f07 from '../../sample-archive/07-安徽-撤销终止-HF2024-XM-082.txt?raw';
import f08 from '../../sample-archive/08-安徽-重新采购公告-HF2024-XM-082-2.txt?raw';
import f09 from '../../sample-archive/09-四川-互斥标段公告A-SC2024-WZ-305.txt?raw';
import f10 from '../../sample-archive/10-四川-互斥标段公告B-SC2024-WZ-305.txt?raw';
import f11 from '../../sample-archive/11-四川-成交公告A包-复制文本-SC2024-WZ-305.txt?raw';
import f12 from '../../sample-archive/12-浙江-附件摘要-评标情况-ZC2024-017.txt?raw';
import type { ImportFileInput } from '../core/engine';

const pairs: [string, string][] = [
  ['01-浙江-采购意向-ZC2024-017.txt', f01],
  ['02-浙江-招标公告-ZC2024-017-网页归档.txt', f02],
  ['03-浙江-招标公告-ZC2024-017-打印件副本.txt', f03],
  ['04-浙江-更正公告-预算变动-ZC2024-017.txt', f04],
  ['05-浙江-延期公告-时限调整-ZC2024-017.txt', f05],
  ['06-浙江-中标结果-ZC2024-017-附件摘要.txt', f06],
  ['07-安徽-撤销终止-HF2024-XM-082.txt', f07],
  ['08-安徽-重新采购公告-HF2024-XM-082-2.txt', f08],
  ['09-四川-互斥标段公告A-SC2024-WZ-305.txt', f09],
  ['10-四川-互斥标段公告B-SC2024-WZ-305.txt', f10],
  ['11-四川-成交公告A包-复制文本-SC2024-WZ-305.txt', f11],
  ['12-浙江-附件摘要-评标情况-ZC2024-017.txt', f12],
];

export const SAMPLE_FILES: ImportFileInput[] = pairs.map(([fileName, text]) => ({ fileName, text }));

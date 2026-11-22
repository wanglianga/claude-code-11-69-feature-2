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
// 门户模板演变与抽取质量监测样例（覆盖页面改版、附件化、打印版、规则修复、跨来源同形异义）
import q01 from '../../sample-archive/quality/浙江-2024-04-采购意向-ZJ2024-LM-058.txt?raw';
import q02 from '../../sample-archive/quality/浙江-2024-04-招标公告-ZJ2024-LM-058.txt?raw';
import q03 from '../../sample-archive/quality/浙江-2024-05-更正补预算-ZJ2024-LM-058.txt?raw';
import q04 from '../../sample-archive/quality/浙江-2024-06-中标结果-ZJ2024-LM-058.txt?raw';
import q05 from '../../sample-archive/quality/江苏-2024-03-采购意向-JS2024-JC-011.txt?raw';
import q06 from '../../sample-archive/quality/江苏-2024-04-网页基线-JS2024-JC-011.txt?raw';
import q06b from '../../sample-archive/quality/江苏-2024-04-标签重命名-JS2024-JC-012.txt?raw';
import q07 from '../../sample-archive/quality/江苏-2024-05-预算折叠改版-JS2024-JC-011.txt?raw';
import q08 from '../../sample-archive/quality/江苏-2024-05-政务云公告-JS2024-YJ-022.txt?raw';
import q09 from '../../sample-archive/quality/江苏-2024-06-标段附件化-JS2024-JC-011.txt?raw';
import q10 from '../../sample-archive/quality/江苏-2024-07-来源未披露-JS2024-JC-011.txt?raw';
import q11 from '../../sample-archive/quality/江苏-2024-07-政务云结果-JS2024-YJ-022.txt?raw';
import q12 from '../../sample-archive/quality/江苏-2024-08-归档副本-JS2024-JC-011.txt?raw';
import q13 from '../../sample-archive/quality/江苏-2024-09-渐进改版A-JS2024-PL-099.txt?raw';
import q14 from '../../sample-archive/quality/江苏-2024-09-渐进改版B-JS2024-PL-099.txt?raw';
import q15 from '../../sample-archive/quality/江苏-2024-10-简化结果页-JS2024-JC-011.txt?raw';
import q16 from '../../sample-archive/quality/江苏-2024-11-结构回稳-JS2024-JC-011.txt?raw';
import q17 from '../../sample-archive/quality/江苏-2024-12-渐进改版C-JS2024-JC-011.txt?raw';
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

/** 质量监测样例：文件名统一以 quality/ 前缀归档，便于“仅质量样例”范围统计 */
export const QUALITY_SAMPLE_FILES: ImportFileInput[] = [
  ['浙江-2024-04-采购意向-ZJ2024-LM-058.txt', q01],
  ['浙江-2024-04-招标公告-ZJ2024-LM-058.txt', q02],
  ['浙江-2024-05-更正补预算-ZJ2024-LM-058.txt', q03],
  ['浙江-2024-06-中标结果-ZJ2024-LM-058.txt', q04],
  ['江苏-2024-03-采购意向-JS2024-JC-011.txt', q05],
  ['江苏-2024-04-网页基线-JS2024-JC-011.txt', q06],
  ['江苏-2024-04-标签重命名-JS2024-JC-012.txt', q06b],
  ['江苏-2024-05-预算折叠改版-JS2024-JC-011.txt', q07],
  ['江苏-2024-05-政务云公告-JS2024-YJ-022.txt', q08],
  ['江苏-2024-06-标段附件化-JS2024-JC-011.txt', q09],
  ['江苏-2024-07-来源未披露-JS2024-JC-011.txt', q10],
  ['江苏-2024-07-政务云结果-JS2024-YJ-022.txt', q11],
  ['江苏-2024-08-归档副本-JS2024-JC-011.txt', q12],
  ['江苏-2024-09-渐进改版A-JS2024-PL-099.txt', q13],
  ['江苏-2024-09-渐进改版B-JS2024-PL-099.txt', q14],
  ['江苏-2024-10-简化结果页-JS2024-JC-011.txt', q15],
  ['江苏-2024-11-结构回稳-JS2024-JC-011.txt', q16],
  ['江苏-2024-12-渐进改版C-JS2024-JC-011.txt', q17],
].map(([fileName, text]) => ({ fileName: `quality/${fileName}`, text }));

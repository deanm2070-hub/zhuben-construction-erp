/**
 * Items of the 工程預算書 template (the user's 報價單), section by section. Every one is
 * listed in the budget even when the model gives no quantity, so it can be filled in
 * by hand when pricing. Door / window type rows are left out: types come from the drawings.
 */
export const TEMPLATE_SECTIONS: Record<string, string> = {
  temp: '一、假設工程', site: '二、放樣.土方及搭架工程', rc: '三、結構體工程', finish: '四、泥作.裝修工程', water: '五、防水工程',
  open: '六、門窗工程', misc: '七、雜項工程', road: '八、道路排水溝及圍牆工程', bath: '九、衛浴設備', steel: '十、鋼架工程',
  mep: '十一、水電.弱電.消防工程（依樓地板面積估算）',
};

const T: Record<string, string> = {
  temp: `假設工程.整地工程 式|安全圍籬 M|工地大門 樘|安全圍籬綠化工程 式|工地告示牌 面|營造廢棄物處理及清運費 M3|臨時廁所 式|工地安全警示設備 式|環境清潔費及生活垃圾清運 月|臨時水電申請費 式|臨時水電設備及工程費 式|臨時水費、電費、電話費 月|空氣汙染防制費及各項規費 式|交屋清潔費 坪|專業點工 式|開工、上樑典禮配合工程 式|逕流廢水處理計劃 式|公共設施損壞修復費 式|現場勘驗及使用執照費(含竣工圖製作) 式`,
  site: `放樣 ㎡|挖土 M3|回填 M3|2000PSI預拌混凝土 M3|導溝挖掘及動線鐵板鋪設 式|鋼軌樁50kg/m@50cm, L=5m打鈸工料 支|鋼軌樁50kg/m@50cm, L=10m打鈸工料 支|鋼軌樁50kg/m@50cm, L=5m鑽堡引孔施工 支|鋼軌樁50kg/m@50cm, L=10m鑽堡引孔施工 支|鑽堡機具設備動員機動復員補貼 式|六分擋土板及保護帆布工料 ㎡|施工架 ㎡`,
  rc: `SD420高拉力鋼筋(#6以上.含#6) 噸|SD280高拉力鋼筋(#3~#5) 噸|T頭續接器 個|鋼筋運費 噸|鋼筋綁紮 噸|點焊鋼線網 10∮/100*100 ㎡|點焊鋼線施工 ㎡|4000PSI 預拌混凝土 M3|壓送 出車 趟|壓送 M3|土尾工 工|一般模板組立及損耗 ㎡`,
  finish: `外牆1:3水泥砂漿打底 ㎡|外牆抿石子 ㎡|F1-地坪整體粉光+金鋼砂 ㎡|F2A-地坪1:3水泥砂漿打底 ㎡|F2A-地坪80*80cm拋光石英磚-材料 ㎡|彩色浪板 ㎡|F2A-地坪80*80cm拋光石英磚-貼工 ㎡|F2B-樓梯地坪1:3水泥砂漿打底 ㎡|F2B-樓梯地坪80*80cm拋光石英磚-材料 ㎡|F2B-樓梯地坪80*81cm拋光石英磚(含刻溝+加工) 支|F2B-樓梯地坪80*80cm拋光石英磚-貼工 支|F4-地坪1:3水泥砂漿打底 ㎡|F4-地坪30*30cm地磚-材料 ㎡|F4-地坪30*30cm地磚-貼工 ㎡|F5-地坪1:2防水水泥砂漿打底 ㎡|F5-地坪30*30cm止滑地磚-材料 ㎡|F5-地坪30*30cm止滑地磚-貼工 間|F6-屋頂地坪1:2防水粉光 ㎡|內牆庫板(具有一小時防火時效) ㎡|內牆單面矽酸鈣板(一小時防火時效) ㎡|內牆雙面矽酸鈣板(一小時防火時效) ㎡|W1A-內牆1:3水泥粉光 ㎡|W1A-內牆水泥漆(綠建材) ㎡|W1B-內牆矽酸鈣板批土整平+水泥漆(綠建材) ㎡|W2A-內牆1:2防水水泥砂漿打底 ㎡|W2B-內牆矽酸鈣板批土整平 ㎡|W2C-內牆貼30*60cm磁磚-材料 ㎡|W2C-內牆貼30*60cm磁磚-貼工 ㎡|C1-平頂明架石膏板天花 ㎡|C2-平頂PVC企口天花板 ㎡|綠建材水泥漆踢腳 H=15cm M|廁所.茶水間人造石門檻 支`,
  water: `茶水間地坪.牆面防水處理(H=1.2M) ㎡|廁所地坪.牆面防水處理(H=1.2M) ㎡|洗手間地坪.牆面防水處理(H=1.2M) ㎡|陽台地坪防水處理 ㎡|屋頂地坪防水處理 ㎡|外牆防水處理 ㎡`,
  open: `鋁窗玻璃 才|外牆門窗防水工程 M|門窗填縫 M`,
  misc: `公共排水溝修復工程 式|樓梯不銹鋼扶手及欄杆 M|陽台金屬欄杆 組|廁所搗擺(含門) 間|小便斗隔屏 片|無障礙汽車停車位劃線工程 位|預鑄式污水處理槽(15人份) 座|水保+圍牆工程 式|景觀.綠化.植栽…等工程 式`,
  road: `圍牆 模板(含放樣) ㎡|圍牆 SD280高拉力鋼筋(#3~#5) 噸|圍牆 鋼筋綁紮 噸|圍牆 3500PSI 預拌混凝土 M3|圍牆 壓送 出車 趟|圍牆 壓送 M3|圍牆 土尾工 工|室外地坪 2000PSI 預拌混凝土 M3|室外地坪 壓送出車 趟|室外地坪 壓送 M3|室外地坪 土尾工 工|室外地坪 柏油(5cm)+切溝 ㎡|室外地坪 柏油切溝 式|排水溝(預鑄) M|圍牆 泥作打底 ㎡|圍牆 抿石子 ㎡`,
  bath: `洗手台人造石檯面 座|人造石蓋板 座|明鏡 組|馬桶(座式) 組|馬桶(蹲式) 組|小便斗 組`,
  steel: `RH-300*300*10*15 Kg|RH-400*400*13*21 Kg|RH-500*200*10*16 Kg|RH-588*300*12*20 Kg|RH-488*300*11*18 Kg|RH-450*200*9*14 Kg|RH-400*200*8*13 Kg|RH-300*150*6.5*9 Kg|RH-250*125*6*9 Kg|RH-150*150*7*10 Kg|C-150*50*20*3.2 Kg|19∮風拉桿 Kg|19∮鬆緊器 組|PL鋼板 Kg|高張力螺栓 S10T Kg|基礎螺栓埋設 24∮*800L 支|基礎螺栓埋設 20∮*700L 支|鋼製樓梯 座|剪力釘 19∮*100L 支|施工圖繪製 Kg|工廠製作 Kg|吊裝 Kg|SA2.5級噴砂防火漆 Kg|工地電焊 Kg|運輸 Kg|檢驗及試驗費用 Kg|五金及物料消耗 Kg|安全措施及管理 Kg|無收縮水泥砂漿 處|DECK板 ㎡|屋頂烤漆鍍鋁鋅鋼板 ㎡|外牆複合式鍍鋁鋅彩色鋼板 ㎡|外牆企口型金屬飾板 ㎡|屋脊收邊料 M|外牆收邊料 M|女兒牆收邊料 M|山牆收邊料 M|門窗收邊料 M|台度收邊料 M|不鏽鋼天溝 M`,
  mep: `配電盤設備工程 式|照明,動力配管線工程 式|給排水.汙水工程 式|電信、網路 式|消防工程 式`,
};

export interface TemplateItem { name: string; unit: string }
/** template items of each section, keyed by the section title */
export const BUDGET_TEMPLATE: Record<string, TemplateItem[]> = Object.fromEntries(Object.entries(T).map(([k, s]) => [TEMPLATE_SECTIONS[k], s.split('|').map(x => {
  const i = x.lastIndexOf(' ');
  return { name: x.slice(0, i), unit: x.slice(i + 1) };
})]));

/** Measured items that stand for a template item under another name. */
const ALIAS: [RegExp, RegExp][] = [
  [/^屋頂地坪防水處理$/, /^屋頂.*防水/],
  [/^樓梯不銹鋼扶手及欄杆$/, /^樓梯欄杆/],
  [/^陽台金屬欄杆$/, /欄杆 H=/],
  [/^(配電盤|照明|給排水)/, /^水電工程/],
  [/^電信/, /^弱電工程/],
  [/^消防工程$/, /^消防工程/],
];

const norm = (s: string) => s.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '');
const code = (s: string) => /^([A-Z]\d[A-Z]?)-/.exec(s)?.[1];

/** Whether a measured item already covers a template item (same thing, perhaps spelt longer or combined with "+"). */
export function covers(measured: string, tpl: string): boolean {
  if (ALIAS.some(([t, m]) => t.test(tpl) && m.test(measured))) return true;
  const c = code(tpl);
  if (c) return code(measured) === c;
  const tn = norm(tpl), mn = norm(measured);
  if (tn === mn) return true;
  const parts = measured.split(/[+＋（）()]/).map(p => p.replace(/\s+/g, '')).filter(Boolean);
  return [mn, ...parts].some(p => p === tn || p.startsWith(tn) || (p.length >= 3 && tn.startsWith(p)) || (p.length >= 3 && tn.includes(p)));
}

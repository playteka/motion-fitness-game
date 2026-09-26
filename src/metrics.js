/**
 * 把一帧关键点换算成“动作指标”（BodyFrame）。
 *
 * 这里刻意只使用与人体尺度无关的量：
 *   - 关节角度（度）           → 与身高、摄像头距离无关
 *   - 长度比例（除以躯干长）   → 与摄像头距离无关
 *   - 上下先后关系（y 比较）   → 与左右朝向、镜像无关
 * 因此同一套阈值可以适配不同的人、不同的机位（只要侧对摄像头即可）。
 */

import {
  LM, angleAt2, angleAt3, dist2, mid, tiltFromVertical, signedLineDev, toDeg, clamp,
} from './geometry.js';

export const DEFAULT_CALIB = {
  torsoLen: 0.30,
  thighLen: 0.26,
  shinLen: 0.26,
  upperArmLen: 0.18,
  forearmLen: 0.17,
  ready: false,
  view: 'side',
};

/**
 * 「横着躺」的躯干倾角门槛（度）：超过它就认为身体接近水平。
 * 单独导出是为了让 🎯「运动设定」弹窗显示**真实使用的数值**（见 specs.js），
 * 界面不另抄一份数字。
 */
export const HORIZONTAL_TILT = 55;

/**
 * 「这一帧算不算识别到人」（`frame.ok`）的可见度门槛。
 *
 * 用户反馈原来的 **0.16 / 0.03 偏严**：明明站得清清楚楚也会时不时变灰、被判成「没找到人」。
 * 所以整体放宽，并且把「最差点」这条改成**只看判定真正用得上的点、还允许两个点看不见**：
 *
 *   1. 核心关节（肩 / 肘 / 腕 / 髋 / 膝 / 踝，双侧共 12 个）的**平均**可见度 > `PERSON_VIS_MEAN`；
 *   2. 判定用的 15 个点（上面 12 个 + 鼻 + 双脚）里，**第三差**的那个 > `PERSON_VIS_MIN`
 *      —— 双手举出画面、脚在画面外、头侧过去这类正常情况（一两个点看不见）不再算「没人」；
 *   3. 脸（眼睛 / 耳朵 / 嘴）和手指 6 个点**根本不参与判定**，原来它们也会被算进「最差点」，
 *      一个手指被挡住就整帧作废 —— 这正是「明明识别得到却变灰」的主因，现在不再看了。
 *
 * 三个数一起导出，测试直接引用（免得以后改了代码、测试还在验旧值）。
 */
export const PERSON_VIS_MEAN = 0.10;   // 核心关节平均可见度（原来 0.16）
export const PERSON_VIS_MIN = 0.02;    // 判定点里第三差的可见度（原来只看「任意点 ≥ 0.03」）
export const PERSON_VIS_SLACK = 2;     // 允许几个判定点看不见（手举出画面 / 脚出画 / 头侧过去）

/**
 * 躯干长至少要占画面高度的这个比例，否则这一帧不算「人」。
 *
 * 门槛放宽之后要靠它挡住**退化帧**：跟踪快要丢失时，关键点会一起塌向同一个坐标，
 * 此时「可见度」可能还是很高（滤波后的可见度是慢慢降下去的），但肩到髋的距离已经趋近 0 ——
 * 这种帧喂给识别器会算出毫无意义的姿势（真机上表现为「丢帧瞬间乱跳一步」）。
 * 2% 这个值远低于任何可用姿势（站好时躯干长约 0.25 ~ 0.35，校准建议身体占画面 30% 以上），
 * 所以正常用户永远不会被它挡住。
 */
export const PERSON_MIN_TORSO = 0.02;

const SIDE_IDX = {
  L: { shoulder: LM.L_SHOULDER, elbow: LM.L_ELBOW, wrist: LM.L_WRIST, hip: LM.L_HIP, knee: LM.L_KNEE, ankle: LM.L_ANKLE, heel: LM.L_HEEL, foot: LM.L_FOOT },
  R: { shoulder: LM.R_SHOULDER, elbow: LM.R_ELBOW, wrist: LM.R_WRIST, hip: LM.R_HIP, knee: LM.R_KNEE, ankle: LM.R_ANKLE, heel: LM.R_HEEL, foot: LM.R_FOOT },
};

/**
 * 计算一帧的全部动作指标。
 * @param {Array} metric 已按宽高比校正的关键点
 * @param {object} calib 校准结果（可缺省，缺省时用当前帧自测的比例）
 * @param {number} now 毫秒时间戳
 * @param {boolean} use3d 是否用三维世界坐标计算关节角
 * @param {Array|null} world 世界坐标关键点
 */
export function computeFrame(metric, calib, now, use3d = false, world = null) {
  const base = { ok: false, t: now };
  if (!metric || metric.length < 33) return base;

  const P = (i) => metric[i];
  const shoulderMid = mid(P(LM.L_SHOULDER), P(LM.R_SHOULDER));
  const hipMid = mid(P(LM.L_HIP), P(LM.R_HIP));

  // 画面中点估计的“地面高度”：脚踝是绝大多数动作里的最低支撑点
  const groundY = Math.max(P(LM.L_ANKLE).y, P(LM.R_ANKLE).y);

  const torsoLen = Math.max(1e-3, dist2(shoulderMid, hipMid));

  // 选“看得最清楚”的一侧（侧拍时远侧腿会被遮挡）
  const sides = ['L', 'R'].map((s) => {
    const idx = SIDE_IDX[s];
    const w = Math.min(
      P(idx.hip).v, P(idx.knee).v, P(idx.ankle).v,
      P(idx.shoulder).v, P(idx.elbow).v, P(idx.wrist).v,
    );
    return { s, w, idx };
  }).sort((a, b) => b.w - a.w);
  const best = sides[0];
  const idx = best.idx;

  const use3 = use3d && world && world.length >= 33;
  const angleAt = use3
    ? (a, b, c) => angleAt3(world[a], world[b], world[c])
    : (a, b, c) => angleAt2(metric[a], metric[b], metric[c]);

  // 地面参考线：优先用校准阶段记下的地面（见 calibration.js），没有校准时退回「脚踝最低点」
  const groundCalib = (calib && Number.isFinite(calib.groundY)) ? calib.groundY : null;
  const groundRefFor = (i) => ((groundCalib === null ? groundY : groundCalib) - P(i).y) / torsoLen;

  // ---- 两侧关节角 ----
  const perSide = {};
  for (const s of ['L', 'R']) {
    const I = SIDE_IDX[s];
    const knee = angleAt(I.hip, I.knee, I.ankle);
    const hip = angleAt(I.shoulder, I.hip, I.knee);
    perSide[s] = {
      knee,
      hip,
      /**
       * 单侧「腿伸出去的程度」= **膝角与髋角里更小的那个**。
       *
       * 死虫式用的就是它。为什么不能只看一个角：
       *   - 只看膝角：「大腿还竖在桌面位、只把小腿踢直（脚朝天）」也会满足 —— 那不是死虫式；
       *   - 只看髋角：「腿朝地面放下去、但膝盖还屈着」也会满足 —— 腿并没有伸出去。
       * 取两者的小值 = **两个都到位**才算真的把腿伸出去，而且它仍然是「度」，
       * 可以和别的关节角一样比较、显示、画成图标。
       *
       * 参考值（侧对镜头的仰卧姿）：桌面位（大腿竖直、膝屈 90°）≈ **90°**；
       * 腿伸出去贴地 ≈ **170°~180°**。
       */
      legOut: Math.min(knee, hip),
      elbow: angleAt(I.shoulder, I.elbow, I.wrist),
      /**
       * 肩关节角（**髋-肩-肘**）：判定平板支撑「上臂是不是往下撑住了」。
       *
       * 用户对平板支撑的描述是「主要是判断关节角度，肘 90° 左右、**肩 90° 左右**、
       * 髋膝都在 180 左右、躯干倾角 80° 左右」—— 这里的「肩 90°」就是它：
       * 躯干水平、上臂朝下撑地时，髋-肩-肘 正好接近 **90°**；
       * 而「趴在地上、手臂放在身体两侧」时这个角接近 **180°**，一眼就能区分开。
       * 关键好处：**它不依赖地面线**，所以在床上/机位偏的时候也判得准
       * （原来的「手离地高度 ≤0.55×躯干长」一遇到校准地面线偏低就会误判成「手没撑地」）。
       */
      shoulderAngle: angleAt(I.hip, I.shoulder, I.elbow),
      // 踝角（膝-踝-脚背）：平地站立 ≈ 110，踮脚 ≈ 150 —— 提踵类动作靠它判定
      ankle: angleAt(I.knee, I.ankle, I.foot),
      body: angleAt(I.shoulder, I.hip, I.ankle),
      kneeY: P(I.knee).y,
      hipY: P(I.hip).y,
      ankleY: P(I.ankle).y,
      wristY: P(I.wrist).y,
      // 抬得越高越正：小臂离地 / 膝离地 / 手举过头顶（都除以躯干长）
      wristClear: (groundRefFor(I.wrist)),
      kneeClear: (groundRefFor(I.knee)),
      shoulderClear: (groundRefFor(I.shoulder)),
      armRaised: (P(I.shoulder).y - P(I.wrist).y) / torsoLen,
      vis: Math.min(P(I.hip).v, P(I.knee).v, P(I.ankle).v),
    };
  }

  // 取双侧平均（正面拍摄时更稳），同时保留“更弯的那条腿”用于深蹲/箭步蹲
  const val = (k) => {
    const a = perSide.L[k], b = perSide.R[k];
    if (!Number.isFinite(a)) return b;
    if (!Number.isFinite(b)) return a;
    return (a + b) / 2;
  };

  const kneeBent = Math.min(...['L', 'R'].map((s) => perSide[s].knee).filter(Number.isFinite));
  const kneeExtended = Math.max(...['L', 'R'].map((s) => perSide[s].knee).filter(Number.isFinite));

  // 主判定用的膝角取“看得最清的那一侧”：侧拍时远侧腿常被躯干遮挡、估得不准，
  // 用双侧平均会被它拖偏（这也是“站得笔直却拿不到站姿分”的常见原因）。
  const kneeAngle = Number.isFinite(perSide[best.s].knee) ? perSide[best.s].knee : val('knee');

  const hipAngle = perSide[best.s].hip;
  const bodyStraight = perSide[best.s].body;
  const elbowAngle = perSide[best.s].elbow;
  // 肩关节角（髋-肩-肘）：平板支撑判定「上臂撑住了没有」，同样取看得最清的那一侧
  const shoulderAngle = Number.isFinite(perSide[best.s].shoulderAngle)
    ? perSide[best.s].shoulderAngle : val('shoulderAngle');

  const torsoIncl = tiltFromVertical(hipMid, shoulderMid);          // 0=直立, 90=水平
  /**
   * **「躯干倾角 + 髋关节角」之和**（坐姿体前屈用）。
   *
   * 用户给的运动学描述：「初始关键帧其实就是侧面向镜头坐好，此刻髋角度约 90°、躯干角度约为 0°。
   * 当身体前屈的时候，**躯干角度和髋角度相加之和应该始终在 90° 左右**。」
   * 这确实是几何恒等式：坐在垫子上、双腿伸直放平（大腿水平）时，
   * 躯干与大腿的夹角（髋角）= 90° − 躯干相对竖直的倾角，所以两者之和恒为 ≈90°。
   *
   * 好处：这个和**完全不依赖地面线**，而且能把「站着前折」（≈180°）、
   * 「躺着 / 仰卧屈膝」（180°~270°）一眼排除掉 —— 后两者都不会落在这个区间里。
   */
  const foldSum = torsoIncl + hipAngle;

  // ---- 地面参考线 ----
  // 默认用「脚踝所在的最低点」当地面 —— 站立、俯撑时都对。
  // 但把腿抬起来（仰卧抬腿、反向卷腹）或整个人跳起来时，脚踝会跟着身体一起动，
  // 这时它就不是地面了；所以校准阶段记下的那条地面线优先用（见 calibration.js 的 groundY）。
  const groundRef = (calib && Number.isFinite(calib.groundY)) ? calib.groundY : groundY;

  const shoulderClear = (groundRef - shoulderMid.y) / torsoLen;      // 肩离地高度（躯干长为单位）
  const hipRise = (shoulderMid.y - hipMid.y) / torsoLen;             // 髋相对肩的高度（臀桥用）
  /**
   * 「肩比髋高多少」（躯干长为单位）—— **正数 = 肩在髋上方**。
   *
   * 注意符号：画面坐标 y 向下增长，所以
   *   站立：肩在髋上方 → shoulderAboveHip ≈ **+1.0**（同时 hipRise ≈ −1.0）
   *   仰卧：肩髋齐平   → ≈ 0
   *   臀桥：髋抬到肩上方 → **负数**（hipRise 这时才是正数）
   *
   * 为什么要有这个「和 hipRise 互为相反数」的量：站姿门控（`standUpright`）问的是
   * 「肩是不是明显在髋上方」，用正数表达最不容易写反 —— 曾经这里写成
   * `hipRise ≥ 0.5`（等于要求人几乎是倒立），结果勾腿跳永远提示「还没进入这个动作的姿势」。
   * 门控一律用这个正数版本，`hipRise` 只留给臀桥。
   */
  const shoulderAboveHip = (hipMid.y - shoulderMid.y) / torsoLen;
  const kneeClear = (groundRef - P(idx.knee).y) / torsoLen;          // 膝离地高度
  const wristClear = (groundRef - P(idx.wrist).y) / torsoLen;        // 手离地高度
  const hipLineDev = signedLineDev(shoulderMid, P(idx.ankle), hipMid) / torsoLen; // >0 塌腰, <0 撅臀

  // 视角判断：肩宽 / 躯干长。正面 ≈ 0.8+，侧面 ≈ 0.1~0.4
  // 阈值放宽到 0.72：斜对镜头（约 45°）也当作“能用”，避免误判成正面而拿不到“侧对镜头”的分
  const shoulderW = dist2(P(LM.L_SHOULDER), P(LM.R_SHOULDER));
  const hipW = dist2(P(LM.L_HIP), P(LM.R_HIP));
  const viewRatio = shoulderW / torsoLen;
  const view = viewRatio > 0.72 ? 'front' : 'side';

  // 深蹲/箭步蹲的“髋低于膝”判据（用最弯的那条腿所在侧）
  const kneeSide = perSide[best.s];
  const hipBelowKnee = hipMid.y >= P(idx.knee).y - 0.05 * torsoLen;

  // 大腿与地面的夹角：0° = 大腿水平（深蹲“蹲到水平”），90° = 站立
  const thighDX = P(idx.knee).x - hipMid.x;
  const thighDY = P(idx.knee).y - hipMid.y;
  const thighFromHoriz = Math.abs(toDeg(Math.atan2(Math.abs(thighDY), Math.abs(thighDX))));

  // ---- 正面视角专用：竖直方向的量在正视图里不被压缩 ----
  // 小腿在图中的长度：深蹲时小腿的前倾发生在「前后」方向，正视图看不到，
  // 所以这个长度在下蹲过程中基本不变，是一个稳定的比例尺。
  const shinLen = Math.max(1e-3, dist2(P(idx.knee), P(idx.ankle)));
  // 髋比膝高多少（除以小腿长）：≈1.0 = 站直，≈0 = 蹲到大腿水平，<0 = 蹲过水平。
  // 这正是「蹲到平行」的严格定义，而且正对镜头也能测准。
  const hipAboveKnee = (P(idx.knee).y - hipMid.y) / shinLen;

  // ---- 校准用：人体在画面里的大小与位置 ----
  const bodyTop = Math.min(P(LM.NOSE).y, shoulderMid.y);
  const bodyBottom = groundY;
  const bodySpan = bodyBottom - bodyTop;
  const centerX = (shoulderMid.x + hipMid.x) / 2;
  // 上面这些量的单位是「画面高度」，而 x 还要除回宽高比才是「画面宽度比例」，
  // 校准的目标轮廓是画在归一化坐标里的，所以这里给出宽度比例版本，两者才能直接比较。
  const aspect = metric.aspect || 1;
  const centerXFrac = centerX / aspect;

  // ---- 躺姿（俯卧撑 / 平板支撑 / 臀桥）专用：躺下时身体是横着的 ----
  // 站立动作用 bodySpan（竖直跨度）判断「距离是否合适」；躺姿的竖直跨度只剩身体厚度
  //（约 0.2），拿它判断距离会永远不达标 —— 所以躺姿改量「身体在水平方向有多长」，
  // 单位同样是画面高度，阈值区间可以直接复用。
  const boxIdx = [
    LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP,
    LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE, LM.L_FOOT, LM.R_FOOT,
  ];
  const boxXs = boxIdx.map((i) => metric[i].x);
  const boxYs = boxIdx.map((i) => metric[i].y);
  const bodyLeft = Math.min(...boxXs);
  const bodyRight = Math.max(...boxXs);
  const bodySpanX = bodyRight - bodyLeft;       // 身体水平长度（画面高度为单位）
  const bodyLeftFrac = bodyLeft / aspect;       // 换成「画面宽度比例」，好跟轮廓比较
  const bodyRightFrac = bodyRight / aspect;
  const bodyMidFrac = (bodyLeftFrac + bodyRightFrac) / 2;
  const bodyTopY = Math.min(...boxYs);          // 躺姿的上下范围（抬腿时膝是最高的）
  const bodyBottomY = Math.max(...boxYs);
  // 侧拍时人可能朝左也可能朝右（±1）：用来把校准轮廓左右翻过来对上朝向
  const facingX = P(LM.NOSE).x >= hipMid.x ? 1 : -1;

  // 躯干相对竖直的倾斜（带方向：正=前倾到 +x 方向）
  const trunkLean = torsoIncl;

  // 膝盖内扣（仅正面视角有效）：膝间距明显小于踝间距
  const kneeGap = Math.abs(P(LM.L_KNEE).x - P(LM.R_KNEE).x);
  const ankleGap = Math.abs(P(LM.L_ANKLE).x - P(LM.R_ANKLE).x);
  const valgus = view === 'front' && ankleGap > 0.02 ? 1 - kneeGap / ankleGap : 0;

  // ---- 多动作库（22 个动作）共用的姿势判据量 ----
  // 地面参考线 groundRef 已经在上面定义（校准地面优先、否则用脚踝最低点）。
  // 有了它才能判断「脚离地（跳起来了）」「人是坐着还是站着」「悬垂」这类问题 ——
  // 只靠脚踝自己算出来的地面会跟着人一起上下动，跳起来时永远看不出离地。
  const hipClear = (groundRef - hipMid.y) / torsoLen;                 // 髋离地高度（站立≈1.0，坐地≈0.2，跪≈0.7）
  const ankleClear = (groundRef - Math.min(P(LM.L_ANKLE).y, P(LM.R_ANKLE).y)) / torsoLen; // 脚离地高度（跳跃 >0）
  const kneeSpread = Math.abs(P(LM.L_KNEE).x - P(LM.R_KNEE).x) / torsoLen;   // 双膝横向距离（相扑/蝴蝶/青蛙式）
  const ankleSpread = Math.abs(P(LM.L_ANKLE).x - P(LM.R_ANKLE).x) / torsoLen; // 双踝横向距离（前后/左右站距）
  /**
   * 双腿开合幅度：膝间距与踝间距里**更大的那个**（开合跳用）。
   *
   * 真人跳开时**脚的张开幅度明显大于膝盖**（腿是往外撑的，膝盖只走到中间），
   * 所以只量膝盖会低估开合幅度 —— 用户反馈「开合跳跳了很多次一次都没计上、卡在第三关键帧」，
   * 实测就是这个原因：膝盖读数卡在 0.8~0.9，而当时的计数线要求 0.98。
   * 取两者的较大值：谁张开得多就用谁，脚出画只看得见膝盖时也照样能用。
   */
  const legSpread = Math.max(kneeSpread, ankleSpread);
  // 双手相对髋部中线的偏移（俄罗斯转体：左右转体时正负翻转）
  const wristMidX = (P(LM.L_WRIST).x + P(LM.R_WRIST).x) / 2;
  const wristTwist = (wristMidX - hipMid.x) / torsoLen;
  // 双手相对肩部的高度：举过头顶为正（倒立撑 / 悬垂举腿 / 伸展类）
  const armRaised = (shoulderMid.y - Math.min(P(LM.L_WRIST).y, P(LM.R_WRIST).y)) / torsoLen;
  // 倒立：髋高于肩（头朝下）
  const inverted = hipMid.y < shoulderMid.y - 0.05 * torsoLen;
  // 横着躺（俯卧 / 仰卧 / 侧卧都算）：躯干接近水平。用 >= 与 GATE_LIMITS.sideLying 的
  // 区间判定保持一致（界面显示的数值和这里判的是同一条规则）。
  const horizontal = torsoIncl >= HORIZONTAL_TILT;
  // 四点支撑（熊爬 / 鸟狗 / 猫牛）：躯干水平 + 手撑地 + 膝也在低位
  const quadruped = horizontal && (groundRef - Math.min(P(LM.L_WRIST).y, P(LM.R_WRIST).y)) / torsoLen < 0.75
    && (groundRef - Math.min(P(LM.L_KNEE).y, P(LM.R_KNEE).y)) / torsoLen < 0.75
    && shoulderMid.y < groundRef - 0.35 * torsoLen;
  // 双肘/双膝的最弯与最直（弓箭手俯卧撑、单臂动作要看单侧）
  const elbowBent = Math.min(...['L', 'R'].map((s) => perSide[s].elbow).filter(Number.isFinite));
  const elbowExtended = Math.max(...['L', 'R'].map((s) => perSide[s].elbow).filter(Number.isFinite));
  const ankleAngle = Math.min(...['L', 'R'].map((s) => perSide[s].ankle).filter(Number.isFinite));
  // 双手离地高度（俯卧撑类：手撑在地面 ≈0；手撑在椅子/箱子上会明显更高）
  const wristClearMin = Math.min(...['L', 'R'].map((s) => perSide[s].wristClear).filter(Number.isFinite));

  // 只看核心关节的平均可见度：个别末端点（手指、耳朵）被遮挡不应该判定为“没人”
  const coreIdx = [
    LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP,
    LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE,
    LM.L_ELBOW, LM.R_ELBOW, LM.L_WRIST, LM.R_WRIST,
  ];
  const coreVis = coreIdx.reduce((s, i) => s + (metric[i].v ?? 1), 0) / coreIdx.length;

  // 「最差点」只看判定用得上的 15 个点，并允许 PERSON_VIS_SLACK 个点看不见（见文件头的门槛说明）：
  // 脸和手指不参与判定，不再拖后腿；双手举出画面、脚出画这类正常情况也不再判成「没人」。
  const JUDGE_IDX = [...coreIdx, LM.NOSE, LM.L_FOOT, LM.R_FOOT];
  const judgeVis = JUDGE_IDX.map((i) => metric[i].v ?? 1).sort((a, b) => a - b);
  const visFloor = judgeVis[PERSON_VIS_SLACK] ?? 1;

  // 全身是否入镜：至少一侧“髋-膝-踝-肩-肘-腕”链条清楚可见；
  // 真机侧拍时远侧肢体可见度天然偏低，所以门槛放宽，并允许用核心关节平均可见度兜底
  // 可见度门槛整体放宽（用户反馈识别太严）：只要核心关节大致看得见就算「识别到人」
  const bodyVisible = best.w > 0.28 || coreVis > 0.38;
  const legVisL = Math.min(P(LM.L_HIP).v, P(LM.L_KNEE).v, P(LM.L_ANKLE).v);
  const legVisR = Math.min(P(LM.R_HIP).v, P(LM.R_KNEE).v, P(LM.R_ANKLE).v);
  const legsVisible = legVisL > 0.16 && legVisR > 0.16;

  return {
    ok: coreVis > PERSON_VIS_MEAN && visFloor > PERSON_VIS_MIN && torsoLen > PERSON_MIN_TORSO,
    t: now,
    side: best.s,
    perSide,
    // 关节角
    kneeAngle,
    kneeBent,
    kneeExtended,
    kneeFar: kneeExtended,
    hipAngle,
    elbowAngle,
    // 肩关节角（髋-肩-肘）：平板支撑用它判「上臂有没有撑住」（不依赖地面线）
    shoulderAngle,
    // 「躯干倾角 + 髋角」之和：坐姿体前屈的恒等式 ≈90°（见上面的说明）
    foldSum,
    bodyStraight,
    // 比例量
    torsoLen,
    torsoIncl,
    trunkLean,
    shoulderClear,
    hipRise,
    shoulderAboveHip,
    kneeClear,
    wristClear,
    hipLineDev,
    hipBelowKnee,
    thighFromHoriz,
    shinLen,
    hipAboveKnee,
    bodyTop,
    bodyBottom,
    bodySpan,
    centerX,
    centerXFrac,
    bodySpanX,
    bodyLeftFrac,
    bodyRightFrac,
    bodyMidFrac,
    bodyTopY,
    bodyBottomY,
    facingX,
    valgus,
    view,
    viewRatio,
    // 多动作库共用的姿势量
    groundRef,
    groundRefCalibrated: groundCalib !== null,   // 地面线是校准出来的（而不是脚踝临时估的）
    hipClear,
    ankleClear,
    kneeSpread,
    ankleSpread,
    legSpread,
    wristTwist,
    armRaised,
    inverted,
    horizontal,
    quadruped,
    elbowBent,
    elbowExtended,
    ankleAngle,
    wristClearMin,
    bodyVisible,
    legsVisible,
    coreVis,
    visFloor,
    groundY,
    shoulderWidth: shoulderW,
    hipWidth: hipW,
    points: metric,
    worldOk: !!use3,
  };
}

/** 逐帧指数平滑（用于躯干长这类缓慢变化的量） */
export function ema(prev, next, alpha = 0.05) {
  if (!Number.isFinite(prev)) return next;
  return prev + (next - prev) * alpha;
}

export function pick(obj, keys, fallback) {
  for (const k of keys) if (Number.isFinite(obj[k])) return obj[k];
  return fallback;
}

export { clamp };

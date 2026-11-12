# Summa i18n 术语表（Glossary）

- **状态：定稿（2026-11-12 用户审定）。** 初稿已经用户审阅通过，7 个待定项全部按推荐定版（见第三节）；批量翻译按本表执行。
- **强制口径**：定稿后，7 个语种词典（public/messages/*.json）的批量翻译必须逐词按本表执行；同一术语在所有文案、页面与邮件里只许用本表这一个译法，不许同义词混用。
- **修订流程**：审阅时直接在本文件里改译法（或标注替换），改完把状态改为「定稿」再开工批量翻译；定稿后如需改词，先改本表、再全局替换词典，不许只改词典不改表。
- **抽词依据**：英文源词典 public/messages/en.json 全部 357 条文案。只收文案里实际出现的术语；cookie、webhook、materials 等词未出现在界面文案中，本表不收（归因机制靠 visitor token 实现，文案只讲 attribution window）。
- **定版说明**：初稿曾有 7 项标「待定」，已于 2026-11-12 经用户审定、全部采用推荐译法；其余译法按各语种行业惯用说法定稿。

## 一、核心术语（33 个）

| 术语 | en 注 | zh-TW | ja | ko | es | pt | fr |
|---|---|---|---|---|---|---|---|
| Affiliate | 推广员：通过推广链接/折扣码带来成交、按比例赚佣金的人或伙伴 | 推廣員 | アフィリエイター | 제휴 파트너 | afiliado | afiliado | affilié |
| Program | 推广计划：一个商家的一整套佣金/折扣/归因规则 | 推廣計畫 | プログラム | 프로그램 | programa | programa | programme |
| Commission | 佣金：每笔转化按计划费率算出的应付金额 | 佣金 | 報酬 | 수수료 | comisión | comissão | commission |
| Conversion | 转化：一笔被成功归因并上报的成交订单 | 轉化 | コンバージョン | 전환 | conversión | conversão | conversion |
| Click | 点击：访客点了一次推广链接并被记录 | 點擊 | クリック | 클릭 | clic | clique | clic |
| Referral link | 推广链接：带推广员 code 的专属链接 | 推廣連結 | アフィリエイトリンク | 추천 링크 | enlace de referido | link de indicação | lien d'affiliation |
| Discount code | 折扣码：管理员发放、买家下单时享折扣的代码 | 折扣碼 | 割引コード | 할인 코드 | código de descuento | código de desconto | code de réduction |
| Attribution window | 归因窗口：点击后多少天内的转化算该推广员的 | 歸因窗口 | アトリビューション期間 | 기여 기간 | ventana de atribución | janela de atribuição | fenêtre d'attribution |
| Commission hold | 佣金冻结期：佣金先冻结、满期才可打款的等待期 | 佣金凍結期 | 保留期間 | 보류 기간 | período de retención | período de retenção | période de retenue |
| Release matured | 解冻：把已满冻结期的佣金释放为可用 | 釋放到期佣金 | 保留解除 | 만기분 보류 해제 | liberar vencidas | liberar vencidas | libérer les commissions échues |
| Available balance | 可用余额：已解冻、尚未打款的佣金合计 | 可用餘額 | 利用可能残高 | 사용 가능 잔액 | saldo disponible | saldo disponível | solde disponible |
| Payable now | 目前可打款：可用余额扣掉未抵清欠债后真正能打的数 | 目前可打款 | 支払可能額 | 지급 가능 금액 | importe pagable | valor a pagar | montant payable |
| Payout | 打款：把一期佣金实际付给推广员（单据亦同名） | 打款 | 支払い | 지급 | pago | pagamento | paiement |
| Payout method | 打款方式：银行转账、Wise、PayPal 等 | 打款方式 | 支払方法 | 지급 방법 | método de pago | método de pagamento | mode de paiement |
| Settlement | 结算单：把某推广员当时全部可用佣金汇总成的一张待打款单 | 結算單 | 精算 | 정산 | liquidación | liquidação | décompte |
| Clawback | 冲销：因退款/拒付按比例追回已记的佣金 | 沖銷 | 報酬取り消し | 환수 | reversión | estorno | récupération |
| Refund | 退款：把订单款退还给买家 | 退款 | 返金 | 환불 | reembolso | reembolso | remboursement |
| Chargeback | 拒付：持卡人通过银行强制退回的款项 | 拒付 | チャージバック | 차지백 | contracargo | chargeback | rétrofacturation |
| First order / Renewal | 订单类型二分：首单 / 订阅续订 | 首單 / 續訂 | 初回注文 / 更新 | 첫 주문 / 갱신 | primer pedido / renovación | primeiro pedido / renovação | première commande / renouvellement |
| Order amount | 订单金额：买家该笔订单的成交额 | 訂單金額 | 注文金額 | 주문 금액 | importe del pedido | valor do pedido | montant de la commande |
| Gross / Effective amount | 毛额 / 有效额：佣金全额 / 扣掉冲销后的实际额 | 毛額 / 有效額 | 総額 / 実額 | 총액 / 유효 금액 | bruto / efectivo | bruto / efetivo | brut / effectif |
| Debt offset | 抵债额：打款时先拿佣金抵掉此前欠债的部分 | 抵債額 | 債務相殺額 | 채무 상계액 | compensación de deuda | compensação de dívida | compensation de dette |
| Audit log | 审计日志：关键操作的留痕记录 | 稽核日誌 | 監査ログ | 감사 로그 | registro de auditoría | registro de auditoria | journal d'audit |
| API key | API 密钥：服务端上报转化时用的鉴权凭证，只存哈希 | API 金鑰 | APIキー | API 키 | clave de API | chave de API | clé API |
| Idempotency key | 幂等键：防同一笔转化被重复上报的唯一键 | 冪等金鑰 | 冪等キー | 멱등성 키 | clave de idempotencia | chave de idempotência | clé d'idempotence |
| Invite | 邀请：管理员邀请推广员加入计划 | 邀請 | 招待 | 초대 | invitación | convite | invitation |
| Activation link | 激活链接：推广员凭此一次性链接设密码激活账号 | 啟用連結 | 有効化リンク | 활성화 링크 | enlace de activación | link de ativação | lien d'activation |
| Administrator | 管理员：计划运营方的后台账号 | 管理員 | 管理者 | 관리자 | administrador | administrador | administrateur |
| Email notifications | 邮件通知设置：推广员自选收哪些事务邮件 | 電子郵件通知設定 | メール通知設定 | 이메일 알림 설정 | notificaciones por correo electrónico | notificações por e-mail | notifications par e-mail |
| Visitor | 访客：点推广链接进来的人，靠 token 识别 | 訪客 | 訪問者 | 방문자 | visitante | visitante | visiteur |
| Landing page | 落地页：推广链接默认把访客送到的页面 | 落地頁 | ランディングページ | 랜딩 페이지 | página de destino | página de destino | page de destination |
| Channel | 渠道：推广员给链接打的来源标签，如 youtube、newsletter | 渠道 | チャネル | 채널 | canal | canal | canal |
| Basis points | 基点：费率单位，1500 个基点 = 15% | 基點 | ベーシスポイント | 베이시스 포인트 | puntos básicos | pontos-base | points de base |

## 二、状态名（15 个，各状态全局只用此译法）

| 术语 | en 注 | zh-TW | ja | ko | es | pt | fr |
|---|---|---|---|---|---|---|---|
| Pending activation | 推广员状态：已邀请、未激活 | 待啟用 | 有効化待ち | 활성화 대기 | Pendiente de activación | Pendente de ativação | En attente d'activation |
| Active | 推广员/链接状态：生效中 | 啟用中 | 有効 | 활성 | Activo | Ativo | Actif |
| Disabled | 推广员/链接状态：已停用 | 已停用 | 無効 | 비활성 | Desactivado | Desativado | Désactivé |
| Holding | 佣金状态：冻结中、未满期 | 凍結中 | 保留中 | 보류 중 | En retención | Em retenção | En retenue |
| Available | 佣金状态：已解冻、待打款 | 可用 | 利用可能 | 사용 가능 | Disponible | Disponível | Disponible |
| Paid | 佣金/打款状态：已打款 | 已打款 | 支払済み | 지급 완료 | Pagado | Pago | Payé |
| Reversed | 佣金状态：已全额冲销 | 已沖銷 | 取り消し済み | 환수됨 | Revertido | Estornado | Récupéré |
| Rejected | 佣金状态：审核驳回（终态） | 已駁回 | 却下 | 반려 | Rechazado | Rejeitado | Rejeté |
| Pending review | 佣金状态：待管理员审核 | 待審核 | 審査待ち | 검토 대기 | Pendiente de revisión | Pendente de revisão | En attente d'examen |
| Revoked | API 密钥状态：已撤销失效 | 已撤銷 | 失効 | 폐기됨 | Revocada | Revogada | Révoquée |
| Confirmed | 转化状态：已确认 | 已確認 | 確定 | 확정 | Confirmada | Confirmada | Confirmée |
| Refunded | 转化状态：已（部分或全额）退款 | 已退款 | 返金済み | 환불됨 | Reembolsada | Reembolsada | Remboursée |
| Chargebacked | 转化状态：已拒付 | 已拒付 | チャージバック済み | 차지백됨 | Con contracargo | Com chargeback | Rétrofacturée |
| Pending | 打款状态：已生成、待标记打款 | 待處理 | 支払い待ち | 지급 대기 | Pendiente | Pendente | En attente |
| Failed | 打款状态：标记失败、佣金已退回可用池 | 失敗 | 失敗 | 실패 | Fallido | Com falha | Échoué |

## 三、原待定项定版记录（7 项，2026-11-12 用户审定，全部采用推荐译法）

1. **Commission（ja）**：候选 A「報酬」（日本联盟平台后台最常见的短称）／候选 B「成果報酬」（正式说法，强调按成果付费）。**推荐 A 報酬**：界面空间小、与「保留期間」等词搭配自然；正式文档里再用成果報酬。
2. **Referral link（fr）**：候选 A「lien d'affiliation」（联盟营销本行说法）／候选 B「lien de parrainage」（更偏「推荐好友」类项目）。**推荐 A**：本产品是联盟营销、不是拉好友返利。
3. **Referral link（pt）**：候选 A「link de indicação」（巴西葡语通行，Hotmart 等平台用法）／候选 B「link de referência」（葡萄牙葡语更常见）。**推荐 A**：联盟营销卖家市场以巴西为主。
4. **Attribution window（ja）**：候选 A「アトリビューション期間」（现代广告/联盟行业的标准说法）／候选 B「クッキー期間」（日本老一代联盟平台的旧称）。**推荐 A**：本产品归因不只靠 cookie，旧称会误导。
5. **Settlement（ja）**：候选 A「精算」（会计上的结算口径，与「生成结算单」动作贴合）／候选 B「支払明細」（偏「付款明细单」）。**推荐 A 精算**：单据本身的明细页再用明細表述。
6. **Clawback（ja）**：候选 A「報酬取り消し」（对推广员最直白：佣金被取消）／候选 B「クローバック」（金融业外来语，推广员未必懂）。**推荐 A**。
7. **Effective amount（ja）**：候选 A「実額」（实际金额，账目界面常见）／候选 B「実効額」（直译 effective，日本账目里少见）。**推荐 A 実額**。

## 四、不翻译清单（处理口径）

- **品牌名 Summa**：全部语种保持拉丁字母原样，不音译、不意译。
- **币种代码**：USD、EUR 等 ISO 三字母代码保持原样；金额一律「数字 + 代码」呈现，不写币种符号换算。
- **专有名词**：Wise、PayPal、Stripe、Paddle 保持英文原名；版本名「Pro」保持原样。
- **技术缩写**：API、CSV、URL、IP 保持英文缩写；bps 在各语种用本表「基点」类全称表述，必要时括注 (bps)。
- **占位符**：文案中的 {programName}、{affiliateName}、{amountCents}、{activationUrl} 等占位符必须逐字节原样保留，不翻译、不改名、不动括号。
- **标识类字符串**：折扣码、链接 code、slug、幂等键、外部交易号（externalRef）属于数据而非文案，永不翻译。
- **英文源里的产品自称**：home 页一类品牌口号句按整句翻译，不受单术语表逐词约束，但其中的术语仍须与本表一致。

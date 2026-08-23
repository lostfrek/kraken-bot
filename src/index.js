require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { createWorker, OEM, PSM } = require("tesseract.js");
const englishOcrData = require("@tesseract.js-data/eng");
const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContainerBuilder,
  EmbedBuilder,
  AuditLogEvent,
  Events,
  GatewayIntentBits,
  LabelBuilder,
  MessageFlags,
  MessageType,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  PresenceUpdateStatus,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const {
  closeStorage,
  deleteUserProfile,
  flushStorage,
  getActiveGameAfkSessions,
  getApplications,
  getBotInfo,
  getCaptReplayWindow,
  getGameAfkSession,
  getMpPoints,
  getMpRequests,
  getRankHistory,
  getSupportTickets,
  getUserDb,
  getWarnings,
  initStorage,
  reloadStorage,
  removeGameAfkSession,
  saveApplications,
  saveBotInfo,
  saveCaptReplayWindow,
  saveGameAfkSession,
  saveMpPoints,
  saveMpRequests,
  saveRankHistory,
  saveSupportTickets,
  saveUserDb,
  saveWarnings,
  syncUserProfile,
  takeExpiredGameAfkSessions
} = require("./storage");

const configPath = path.join(__dirname, "..", "config.json");
if (!fs.existsSync(configPath)) {
  throw new Error("Не найден обязательный файл config.json.");
}
const config = require(configPath);
const applicationEmojis = require("./application-emojis.json");

function applicationEmoji(name) {
  return applicationEmojis[name] ?? applicationEmojis.notice;
}

function applicationEmojiMention(name) {
  const emoji = applicationEmoji(name);
  return `<:${emoji.name}:${emoji.id}>`;
}

function applicationEmojiReaction(name) {
  const emoji = applicationEmoji(name);
  return `${emoji.name}:${emoji.id}`;
}

function loadingMessage(text) {
  return `${applicationEmojiMention("loading")} | ${text}`;
}

function successMessage(text) {
  return `${applicationEmojiMention("confirm")} | ${text}`;
}

function errorMessage(text) {
  return `${applicationEmojiMention("cancel")} | ${text}`;
}

function noticeMessage(text) {
  return `${applicationEmojiMention("notice")} | ${text}`;
}

function adminActionResult(title, completed = [], failed = []) {
  const sections = [];
  if (completed.length) {
    sections.push(`**${title}:**\n${completed.map((line) => `• ${line}`).join("\n")}`);
  }
  if (failed.length) {
    sections.push(`**Не выполнено:**\n${failed.map((line) => `• ${line}`).join("\n")}`);
  }
  const content = sections.join("\n\n") || "Изменения не применены.";
  return completed.length ? successMessage(content) : noticeMessage(content);
}

function modalCustomId(...parts) {
  return [...parts, crypto.randomBytes(5).toString("hex")].join(":");
}

const pendingConfirmations = new Map();
const activeAfkPanels = new Map();

function confirmationPayload(id, text) {
  return {
    content: text,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`action-confirm:${id}`)
        .setLabel("Подтвердить")
        .setEmoji(applicationEmoji("confirm"))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`action-cancel:${id}`)
        .setLabel("Отменить")
        .setEmoji(applicationEmoji("cancel"))
        .setStyle(ButtonStyle.Secondary)
    )],
    flags: MessageFlags.Ephemeral
  };
}

function confirmationText(interaction) {
  if (interaction._confirmed) return null;
  if (interaction.isChatInputCommand()) {
    const command = interaction.commandName;
    if (command === "move" && isLeadership(interaction.member)) {
      return `Вы уверены, что хотите переместить всех участников из ${interaction.options.getChannel("from", true)} в ${interaction.options.getChannel("to", true)}?`;
    }
    return null;
  }
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (id.startsWith("support:close:") && isSupportReviewer(interaction.member)) return "Вы уверены, что хотите закрыть это обращение?";
    if (id.startsWith("mpocr:approve:") && interaction.user.id === MP_REPORT_REVIEWER_ID) return "Вы уверены, что хотите подтвердить начисление баллов МП?";
    if (id.startsWith("mpocr:reject:") && interaction.user.id === MP_REPORT_REVIEWER_ID) return "Вы уверены, что хотите отклонить начисление баллов МП?";
    if (id === "game_afk:return") return "Вы уверены, что хотите вернуться из AFK?";
    return null;
  }
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;
    if (id.startsWith("application:reject-reason:")) return "Вы уверены, что хотите отклонить эту заявку?";
  }
  return null;
}

function confirmedInteraction(original, button) {
  const normalize = (payload) => {
    const normalized = typeof payload === "string" ? { content: payload } : { ...payload };
    delete normalized.flags;
    if (!Object.hasOwn(normalized, "components")) normalized.components = [];
    return normalized;
  };
  return new Proxy(original, {
    get(target, property) {
      if (property === "_confirmed") return true;
      if (property === "reply") return (payload) => button.update(normalize(payload));
      if (property === "deferReply" || property === "deferUpdate") {
        return () => button.update({
          content: loadingMessage("Пожалуйста, подождите, действие выполняется..."),
          components: []
        });
      }
      if (property === "editReply") return (payload) => button.editReply(normalize(payload));
      if (property === "followUp") return (payload) => button.editReply(normalize(payload));
      if (property === "showModal") {
        return async (modal) => {
          await button.showModal(modal);
          await button.deleteReply().catch(() => null);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function requestActionConfirmation(interaction, text) {
  const now = Date.now();
  for (const [pendingId, pending] of pendingConfirmations) {
    if (pending.expiresAt < now) pendingConfirmations.delete(pendingId);
  }
  const id = crypto.randomBytes(8).toString("hex");
  pendingConfirmations.set(id, {
    interaction,
    ownerId: interaction.user.id,
    expiresAt: now + 5 * 60 * 1000
  });
  await interaction.reply(confirmationPayload(id, text));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
});

const APPLICATION_REJECTION_COOLDOWN_MS = 10 * 24 * 60 * 60 * 1000;
const APPLICATION_PANEL_CHANNEL_ID = "1315860449442398239";
const SUPPORT_PANEL_CHANNEL_ID = "1509572136694452407";
const ADMIN_PANEL_CHANNEL_ID = "1291543297747194010";
const CAPT_REPLAY_CHANNEL_ID = "1540244840250351666";
const CAPT_REPLAY_WINDOW_MS = 90 * 60 * 1000;
const CAPT_REPLAY_SWEEP_INTERVAL_MS = 30 * 1000;
const VERIFIED_MEMBER_ROLE_ID = "1265995505524015245";
const SUPPORT_REQUEST_TYPES = {
  mp_points: "Заявка на начисление баллов",
  bonus: "Заявка на премию",
  promotion: "Заявка на повышение",
  vacation: "Заявка на отпуск",
  other: "Другое"
};
const MAJESTIC_ONLINE_API_URL = "https://wiki.majestic-rp.ru/api/online";
const BOT_STATUS_UPDATE_INTERVAL_MS = 30 * 1000;
const GAME_AFK_SWEEP_INTERVAL_MS = 30 * 1000;
const STORAGE_RELOAD_INTERVAL_MS = 60 * 1000;
const GAME_AFK_MAX_HOURS = 4;
const MP_REPORT_CHANNEL_ID = "1315852973368152155";
const MP_REPORT_REVIEWER_ID = "629552401237540874";
const MP_EXCLUDED_MIN_RANK = 8;
const MP_EVENT_TYPES = [
  { key: "construction", label: "Подставная стройка", points: 5, aliases: ["подставная стройка", "стройка"] },
  { key: "grover", label: "Гровер", points: 15, aliases: ["гровер"] },
  { key: "valuable", label: "Ценная партия", points: 10, aliases: ["ценная партия"] },
  { key: "kidnapping", label: "Похитка", points: 10, aliases: ["похитка", "похищение"] },
  { key: "conspiracy_1", label: "Конспирация I", points: 10, aliases: ["конспирация i", "конспирация 1", "конспирация"] },
  { key: "capture_win", label: "Удачный захват территории", points: 15, aliases: ["удачный захват территории", "удачный захват", "удачно", "win"] },
  { key: "capture_loss", label: "Неудачный захват территории", points: 5, aliases: ["неудачный захват территории", "неудачный захват", "неудачно", "loss"] }
];
const WARN_ROLE_IDS = {
  1: "1290775235360194610",
  2: "1290775323373211770"
};
const botRankChanges = new Map();
const PROMOTION_REQUIREMENTS = {
  2: { nextRank: 3, points: 75 },
  3: { nextRank: 5, points: 150 },
  5: { nextRank: 6, points: 300 },
  6: { nextRank: 7, points: 450 },
  7: { nextRank: 8, points: 600 }
};
let ocrWorkerPromise;
let ocrQueue = Promise.resolve();
let lastKnownOrlandoOnline = null;

function isLeadership(member) {
  return Boolean(member?.roles?.cache) &&
    config.leadershipRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

function isApplicationReviewer(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)) || isLeadership(member);
}

function isSupportReviewer(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)) || isLeadership(member);
}

function applicationSectionLabel(section) {
  return section === "capt" ? "CAPT-состав" : "RP-состав";
}

async function fetchOrlandoOnline() {
  const response = await fetch(MAJESTIC_ONLINE_API_URL, {
    headers: { "User-Agent": "Kraken-Discord-Bot/1.0" },
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(`Majestic online API returned ${response.status}`);
  }

  const payload = await response.json();
  const servers = payload?.data?.servers;
  if (!Array.isArray(servers)) {
    throw new Error("Majestic online API response has no servers list");
  }

  const orlando = servers.find((server) => server.name?.toLowerCase() === "orlando");
  if (!orlando || !Number.isFinite(orlando.players)) {
    throw new Error("Orlando online was not found in Majestic online API response");
  }

  const queuedPlayers = Number.isFinite(orlando.queuedPlayers) ? orlando.queuedPlayers : 0;
  lastKnownOrlandoOnline = orlando.players + queuedPlayers;
  return lastKnownOrlandoOnline;
}

async function updateBotOnlineStatus(readyClient) {
  try {
    const online = await fetchOrlandoOnline();
    readyClient.user.setActivity(`ORLANDO | ${online} | MAJESTIC RP`, {
      type: ActivityType.Watching
    });
    readyClient.user.setStatus(PresenceUpdateStatus.Online);
  } catch {
    readyClient.user.setActivity(lastKnownOrlandoOnline == null
      ? "ORLANDO | MAJESTIC RP"
      : `ORLANDO | ${lastKnownOrlandoOnline} | MAJESTIC RP`, {
      type: ActivityType.Watching
    });
    readyClient.user.setStatus(PresenceUpdateStatus.Online);
  }
}

function applicantLockedOverwriteOptions() {
  const options = {
    ViewChannel: true,
    ReadMessageHistory: true
  };

  for (const name of Object.keys(PermissionFlagsBits)) {
    if (!["Administrator", "ViewChannel", "ReadMessageHistory"].includes(name)) {
      options[name] = false;
    }
  }

  return options;
}

function createTicketUid(prefix, ...collections) {
  const alphabet = "0123456789";
  const existingUids = new Set(
    collections.flatMap((items) =>
      Object.values(items).flatMap((item) => [item.uid, item.id].filter(Boolean))
    )
  );
  let uid = "";
  do {
    const code = Array.from(
      { length: 10 },
      () => alphabet[crypto.randomInt(0, alphabet.length)]
    ).join("");
    uid = `${prefix}-${code}`;
  } while (existingUids.has(uid));
  return uid;
}

function applicationButtons(application) {
  const isClosed = ["accepted", "rejected", "closed"].includes(application.status);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`application:accept:${application.uid}`)
        .setLabel("Принять")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed),
      new ButtonBuilder()
        .setCustomId(`application:reject:${application.uid}`)
        .setLabel("Отклонить")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed),
      new ButtonBuilder()
        .setCustomId(`application:transfer:${application.uid}`)
        .setLabel("Передать")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed)
    )
  ];
}

function supportTicketButtons(ticket) {
  const isClosed = ["closed", "approved", "rejected"].includes(ticket.status);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`support:close:${ticket.uid}`)
        .setLabel("Закрыть")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed),
      new ButtonBuilder()
        .setCustomId(`support:transfer:${ticket.uid}`)
        .setLabel("Передать")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(isClosed)
    )
  ];
}

function findApplicationByUid(uid) {
  return Object.entries(getApplications()).find(
    ([, application]) => application.uid === uid
  ) ?? null;
}

function getLatestApplicationForUser(userId, applications = getApplications()) {
  return Object.values(applications)
    .filter((application) => application.userId === userId)
    .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0))[0] ?? null;
}

function applicationStatusLabel(status) {
  const labels = {
    new: "Новая заявка",
    in_review: "На рассмотрении",
    accepted: "Принята",
    rejected: "Отклонена",
    closed: "Закрыто"
  };
  return labels[status] ?? "Неизвестно";
}

function discordTimestampFromMs(timestampMs, style = "R") {
  return `<t:${Math.floor(timestampMs / 1000)}:${style}>`;
}

function getMpBalance(userId) {
  const points = getMpPoints();
  return points[userId]?.balance ?? 0;
}

function isMpPointsExcludedRank(rank) {
  const numericRank = Number(rank);
  return !Number.isFinite(numericRank) || numericRank < 2 || numericRank >= MP_EXCLUDED_MIN_RANK;
}

function isMpPointsExcludedMember(member) {
  return isMpPointsExcludedRank(getRankFromMemberRoles(member));
}

function getUserRecord(userId) {
  const users = getUserDb();
  users[userId] ??= { dmNotifications: true };
  users[userId].dmNotifications ??= true;
  saveUserDb(users);
  return users[userId];
}

async function updateUserRecord(userId, updater) {
  const users = getUserDb();
  users[userId] ??= { dmNotifications: true };
  users[userId].dmNotifications ??= true;
  updater(users[userId]);
  await saveUserDb(users);
  return users[userId];
}

async function addUserAudit(userId, type, entry) {
  const record = { ...entry, createdAt: entry.createdAt ?? new Date().toISOString() };
  if (type === "warn") {
    const warnings = getWarnings();
    warnings[userId] ??= { active: [], history: [] };
    warnings[userId].active ??= [];
    warnings[userId].history ??= [];
    warnings[userId].history.push(record);
    await saveWarnings(warnings);
    return;
  }

  const history = getRankHistory();
  history[userId] ??= [];
  history[userId].push(record);
  await saveRankHistory(history);
}

function profileButtons(ownerId, targetId, rank) {
  const notificationsEnabled = getUserRecord(targetId).dmNotifications;
  const mpBlocked = isMpPointsExcludedRank(rank);
  const buttons = [
    ...(!mpBlocked ? [
      new ButtonBuilder().setCustomId(`profile:mp:${ownerId}:${targetId}:0`).setLabel("История баллов").setEmoji(applicationEmoji("mp_history")).setStyle(ButtonStyle.Secondary)
    ] : []),
    new ButtonBuilder().setCustomId(`profile:warn:${ownerId}:${targetId}:0`).setLabel("История варнов").setEmoji(applicationEmoji("warnings")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`profile:rank:${ownerId}:${targetId}:0`).setLabel("История рангов").setEmoji(applicationEmoji("rank_history")).setStyle(ButtonStyle.Secondary)
  ];
  if (ownerId === targetId) buttons.push(
    new ButtonBuilder()
      .setCustomId(`profile:notify:${ownerId}:${targetId}:0`)
      .setLabel(notificationsEnabled ? "Уведомления: вкл." : "Уведомления: выкл.")
      .setEmoji(applicationEmoji(notificationsEnabled ? "notifications_on" : "notifications_off"))
      .setStyle(notificationsEnabled ? ButtonStyle.Success : ButtonStyle.Danger)
  );
  return new ActionRowBuilder().addComponents(buttons);
}

function profileHistoryEntries(targetId, type) {
  if (type === "mp") return (getMpPoints()[targetId]?.history ?? []).map((entry) => ({
    createdAt: entry.createdAt,
    text: `${Number(entry.amount) >= 0 ? "Начислено" : "Списано"}: **${Math.abs(Number(entry.amount) || 0)} МП**\nАдминистратор: ${entry.adminId === "system" ? "Система" : `<@${entry.adminId}>`}\nПричина: ${entry.reason ?? "Не указана"}`
  }));

  const source = type === "warn"
    ? (getWarnings()[targetId]?.history ?? [])
    : (getRankHistory()[targetId] ?? []);
  return source.map((entry) => ({
    createdAt: entry.createdAt,
    text: type === "warn"
      ? `${entry.action === "add" ? "Выдан" : "Снят"} варн\nАдминистратор: ${entry.adminId === "system" ? "Система" : `<@${entry.adminId}>`}\nПричина: ${entry.reason ?? "Не указана"}${entry.warnReason ? `\nВарн: ${entry.warnReason}` : ""}`
      : `Ранг: **${entry.oldRank ?? "нет"} → ${entry.newRank}**\nАдминистратор: ${entry.adminId === "system" ? "Система" : `<@${entry.adminId}>`}\nПричина: ${entry.reason ?? "Не указана"}`
  }));
}

function buildProfileHistory(type, targetId, ownerId, requestedPage) {
  const titles = { mp: "История баллов", warn: "История варнов", rank: "История рангов" };
  const entries = profileHistoryEntries(targetId, type).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const pages = Math.max(1, Math.ceil(entries.length / 10));
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const lines = entries.slice(page * 10, page * 10 + 10).map((entry, index) => {
    const timestamp = Date.parse(entry.createdAt);
    const date = Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:F>` : "Дата неизвестна";
    return `**${page * 10 + index + 1}. ${date}**\n${entry.text}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x79040c)
    .setTitle(titles[type])
    .setDescription(lines.join("\n\n") || "История пока пуста.")
    .setFooter({ text: `Страница ${page + 1}/${pages} • Записей: ${entries.length}` });
  const components = [];
  if (pages > 1) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`profile:${type}:${ownerId}:${targetId}:${page - 1}`).setLabel("Назад").setEmoji(applicationEmoji("back")).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`profile:${type}:${ownerId}:${targetId}:${page + 1}`).setLabel("Вперёд").setEmoji(applicationEmoji("forward")).setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1)
  ));
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`profile:home:${ownerId}:${targetId}:0`).setLabel("К профилю").setEmoji(applicationEmoji("profile")).setStyle(ButtonStyle.Secondary)
  ));
  return embedToComponentPayload(embed, components);
}

async function changeMpBalance(userId, amount, adminId, reason, member = null) {
  if (isMpPointsExcludedMember(member)) {
    return { balance: getMpBalance(userId), appliedAmount: 0, blocked: true };
  }
  const points = getMpPoints();
  points[userId] ??= { balance: 0, lastAwardAt: null, history: [] };
  points[userId].history ??= [];
  const currentBalance = points[userId].balance;
  const appliedAmount = amount < 0 ? -Math.min(Math.abs(amount), currentBalance) : amount;
  const createdAt = new Date().toISOString();
  points[userId].balance = currentBalance + appliedAmount;
  points[userId].history.push({
    amount: appliedAmount,
    requestedAmount: amount,
    adminId,
    reason,
    createdAt
  });
  if (appliedAmount > 0) points[userId].lastAwardAt = createdAt;
  await saveMpPoints(points);
  return { balance: points[userId].balance, appliedAmount };
}

function moscowMidnightIso(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T00:00:00.000Z`;
}

function startMemberAfkGrace(userId, acceptedAt = new Date()) {
  const points = getMpPoints();
  points[userId] ??= { balance: 0, lastAwardAt: null, history: [] };
  points[userId].history ??= [];
  points[userId].lastAwardAt = moscowMidnightIso(acceptedAt);
  return saveMpPoints(points);
}

async function resetMpBalance(userId, adminId, reason) {
  const points = getMpPoints();
  if (!points[userId]) return;
  points[userId].history ??= [];
  points[userId].history.push({
    amount: -points[userId].balance,
    adminId,
    reason,
    createdAt: new Date().toISOString()
  });
  points[userId].balance = 0;
  await saveMpPoints(points);
}

function clearMemberMpPoints(userId) {
  const points = getMpPoints();
  delete points[userId];
  return saveMpPoints(points);
}

function rankRoleIdsFor(rank) {
  const roleId = config.rankRoleIds[String(rank)];
  return roleId ? (Array.isArray(roleId) ? roleId : [roleId]) : [];
}

async function syncMemberRankRole(member, rank) {
  if (!member || !rank) return;
  const configuredRoles = Object.values(config.rankRoleIds)
    .flatMap((roleId) => Array.isArray(roleId) ? roleId : [roleId])
    .map((roleId) => member.guild.roles.cache.get(roleId))
    .filter(Boolean);
  const currentRankRoles = configuredRoles.filter((role) => member.roles.cache.has(role.id));
  // When a rank lists multiple roles (e.g. rank 8: High Staff + Administrator), only the first
  // one is ever auto-assigned here. The rest are manual-only markers — an admin grants them by
  // hand and they still count toward that rank, but the bot never adds them on its own. All of
  // them are still removed automatically once the member leaves that rank.
  const targetRoleIds = rankRoleIdsFor(rank);
  const targetRoles = targetRoleIds
    .map((roleId) => member.guild.roles.cache.get(roleId))
    .filter(Boolean);
  if (!targetRoles.length) throw new Error(`Роль для ${rank} ранга не найдена на Discord-сервере.`);
  const primaryTargetRole = member.guild.roles.cache.get(targetRoleIds[0]);
  const unmanageableRole = [...new Set([...currentRankRoles, ...targetRoles])]
    .find((role) => !role.editable);
  if (unmanageableRole) {
    throw new Error(`Бот не может управлять ролью «${unmanageableRole.name}»: роль бота расположена ниже неё.`);
  }
  botRankChanges.set(member.id, Date.now() + 15_000);

  const targetRoleIdSet = new Set(targetRoles.map((role) => role.id));
  if (primaryTargetRole && !member.roles.cache.has(primaryTargetRole.id)) {
    await member.roles.add(primaryTargetRole);
  }
  for (const role of currentRankRoles) {
    if (!targetRoleIdSet.has(role.id)) await member.roles.remove(role.id);
  }
}

function getRankFromMemberRoles(member) {
  if (!member?.roles?.cache) return null;

  const ranks = Object.entries(config.rankRoleIds)
    .filter(([, roleId]) => {
      const roleIds = Array.isArray(roleId) ? roleId : [roleId];
      return roleIds.some((id) => id && member.roles.cache.has(id));
    })
    .map(([rank]) => Number.parseInt(rank, 10))
    .filter(Number.isFinite);

  if (!ranks.length) return null;
  return Math.max(...ranks);
}

async function listGuildMembers(guild) {
  if (guild.members.cache.size >= guild.memberCount) {
    return [...guild.members.cache.values()];
  }
  const members = [];
  let after;
  let hasMore = true;

  while (hasMore) {
    const batch = await guild.members.list({ limit: 1000, ...(after ? { after } : {}) });
    members.push(...batch.values());
    if (batch.size < 1000) {
      hasMore = false;
      continue;
    }

    const nextAfter = batch.lastKey();
    if (!nextAfter || nextAfter === after) {
      hasMore = false;
      continue;
    }
    after = nextAfter;
  }

  return members;
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

async function resolveTicketTransferMember(guild, input) {
  const value = String(input ?? "").trim();
  const discordId = value.match(/\d{17,20}/)?.[0];
  if (discordId) {
    const member = await guild.members.fetch(discordId).catch(() => null);
    return member
      ? { member }
      : { error: "Участник с таким Discord ID не найден на сервере." };
  }

  const needle = normalizeSearchText(value);
  if (!needle) return { error: "Укажите Discord ID, упоминание или точный ник администратора." };

  const members = await listGuildMembers(guild);
  const matches = members.filter((member) => {
    if (member.user.bot) return false;
    return [
      member.displayName,
      member.user.username,
      member.user.globalName
    ].some((name) => normalizeSearchText(name) === needle);
  });

  if (!matches.length) return { error: "Администратор с таким ником не найден." };
  if (matches.length > 1) {
    return { error: "Найдено несколько участников с таким ником. Укажите Discord ID или упоминание." };
  }
  return { member: matches[0] };
}

function validateTicketTransferMember(member, ticket, scope) {
  if (!member || member.user.bot) return "Передать заявку этому участнику нельзя.";
  if (member.id === ticket.userId) return "Нельзя передать заявку её автору.";
  const allowed = scope === "application"
    ? isApplicationReviewer(member)
    : isSupportReviewer(member);
  if (!allowed) {
    return "Передать заявку можно только ответственной администрации.";
  }
  if (member.id === ticket.claimedBy) return "Эта заявка уже закреплена за указанным администратором.";
  return null;
}

function parseMpReport(content) {
  const normalized = normalizeSearchText(content);
  const type = MP_EVENT_TYPES
    .flatMap((entry) => entry.aliases.map((alias) => ({ entry, alias: normalizeSearchText(alias) })))
    .filter(({ alias }) => normalized.includes(alias))
    .sort((left, right) => right.alias.length - left.alias.length)[0]?.entry;
  const countMatch = String(content ?? "").match(/(?:^|\n)\s*3[.)]?\s*[^\n]*?(\d+)/i);
  return { type, declaredCount: countMatch ? Number.parseInt(countMatch[1], 10) : null };
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("eng", OEM.LSTM_ONLY, {
      langPath: englishOcrData.langPath,
      gzip: englishOcrData.gzip,
      logger: (event) => {
        if (event.status === "recognizing text" && event.progress === 1) return;
      }
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 #-_"
      });
      return worker;
    });
  }
  return ocrWorkerPromise;
}

function isPhoneGreen(red, green, blue) {
  return green > 90 && green > red * 1.25 && green > blue * 1.03 && green - red > 20;
}

function isPhoneRowBorder(red, green, blue) {
  return isPhoneGreen(red, green, blue) ||
    (red > 105 && red > green * 1.25 && red > blue * 1.18 && red - green > 25);
}

function locatePhoneParticipantRows(raw, width, height, channels) {
  const minX = Math.floor(width * 0.30);
  const maxX = Math.floor(width * 0.85);
  let anchorX = -1;
  let anchorScore = 0;

  for (let x = minX; x <= maxX; x += 1) {
    let score = 0;
    for (let y = Math.floor(height * 0.18); y < Math.floor(height * 0.97); y += 1) {
      const offset = (y * width + x) * channels;
      if (isPhoneGreen(raw[offset], raw[offset + 1], raw[offset + 2])) score += 1;
    }
    if (score > anchorScore) {
      anchorX = x;
      anchorScore = score;
    }
  }

  if (anchorX < 0 || anchorScore < Math.max(12, Math.floor(height * 0.015))) return [];
  const activeRows = [];
  for (let y = Math.floor(height * 0.18); y < Math.floor(height * 0.97); y += 1) {
    let active = false;
    for (let x = Math.max(0, anchorX - 3); x <= Math.min(width - 1, anchorX + 4); x += 1) {
      const offset = (y * width + x) * channels;
      if (isPhoneRowBorder(raw[offset], raw[offset + 1], raw[offset + 2])) {
        active = true;
        break;
      }
    }
    if (active) activeRows.push(y);
  }

  const groups = [];
  for (const y of activeRows) {
    const last = groups.at(-1);
    if (!last || y - last.end > 4) groups.push({ start: y, end: y });
    else last.end = y;
  }
  const minHeight = Math.max(14, Math.floor(height * 0.018));
  const maxHeight = Math.floor(height * 0.10);
  return groups
    .filter((group) => group.end - group.start + 1 >= minHeight && group.end - group.start + 1 <= maxHeight)
    .map((group) => ({ ...group, anchorX }));
}

function cleanRecognizedNickname(text) {
  const ignored = new Set(["krkn", "bls", "kren", "online", "indikator", "nad", "golovoi"]);
  const rawLines = String(text ?? "").split(/\r?\n/).map((line) =>
    line.split(/\s+/)
      .map((word) => word.replace(/[^A-Za-z0-9_-]/g, ""))
      .filter((word) => word.length >= 3)
  ).filter((line) => line.length);
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const tagIndex = rawLines[lineIndex].findIndex((word) => word.toLowerCase() === "krkn");
    const firstName = tagIndex > 0 ? rawLines[lineIndex][tagIndex - 1] : null;
    const lastName = rawLines.slice(lineIndex + 1).flat().find((word) => word.toLowerCase() === "kraken");
    if (firstName && lastName) return `${firstName} ${lastName}`;
  }
  const lines = rawLines.map((line) => line.filter((word) => !ignored.has(word.toLowerCase()))).filter((line) => line.length);
  const firstName = lines[0]?.[0];
  const lastName = lines[1]?.[0];
  return [firstName, lastName].filter(Boolean).join(" ").trim();
}

async function recognizeGreenNames(imageBuffer) {
  const image = sharp(imageBuffer).rotate();
  const imageBufferNormalized = await image.png().toBuffer();
  const { data, info } = await sharp(imageBufferNormalized).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = locatePhoneParticipantRows(data, info.width, info.height, info.channels);
  const worker = await getOcrWorker();
  const names = [];

  for (const rowInfo of rows) {
    const remainingWidth = info.width - rowInfo.anchorX;
    const left = Math.min(info.width - 1, rowInfo.anchorX + Math.floor(remainingWidth * 0.16));
    const width = Math.min(Math.floor(remainingWidth * 0.58), info.width - left);
    const top = Math.max(0, rowInfo.start - Math.floor(info.height * 0.004));
    const height = Math.min(rowInfo.end - rowInfo.start + 1 + Math.floor(info.height * 0.008), info.height - top);
    if (height < 10 || width < 10) continue;
    const row = await sharp(imageBufferNormalized)
      .extract({ left, top, width, height })
      .resize({ width: Math.max(600, width * 3) })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
    const result = await worker.recognize(row);
    const nickname = cleanRecognizedNickname(result.data.text);
    if (nickname) names.push(nickname);
  }

  return [...new Set(names)];
}

async function recognizeAllMpScreenshots(attachments) {
  const task = async () => {
    const names = [];
    for (const attachment of attachments) {
      const buffer = await downloadDiscordAttachment(attachment);
      names.push(...await recognizeGreenNames(buffer));
    }
    return [...new Set(names)];
  };
  const result = ocrQueue.then(task, task);
  ocrQueue = result.catch(() => null);
  return result;
}

async function downloadDiscordAttachment(attachment) {
  const urls = [...new Set([attachment.url, attachment.proxyURL].filter(Boolean))];
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(urls[attempt % urls.length], {
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "Kraken-Discord-Bot/1.0" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error(`Не удалось скачать скриншот из Discord после 3 попыток: ${lastError?.message ?? lastError}`);
}

function parseCaptureRows(text) {
  const participants = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine
      .replace(/[|()[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const match = line.match(/^\s*\d+\s+(.+?)\s*#?\s*\d{3,}\s+(.+)$/i);
    if (!match) continue;
    const name = match[1].replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").trim();
    const numericColumns = match[2].match(/\d+/g) ?? [];
    const damage = Number.parseInt(numericColumns.at(-1), 10);
    if (name && Number.isFinite(damage) && damage > 0) participants.push(name);
  }
  return [...new Set(participants)];
}

async function detectCaptureOutcome(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .rotate()
    .resize({ width: 900, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const maxY = Math.max(1, Math.floor(info.height * 0.2));
  let red = 0;
  let green = 0;
  for (let y = 0; y < maxY; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      if (r > 150 && r > g * 1.18 && r > b * 1.12) red += 1;
      if (g > 105 && g > r * 1.12 && g > b * 1.05) green += 1;
    }
  }
  if (red > green * 1.25 && red > 8) return "loss";
  if (green > red * 1.25 && green > 8) return "win";
  return null;
}

async function recognizeCaptureScreenshot(imageBuffer) {
  const worker = await getOcrWorker();
  const prepared = await sharp(imageBuffer)
    .rotate()
    .resize({ width: 1800 })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
  const [outcome, recognition] = await Promise.all([
    detectCaptureOutcome(imageBuffer),
    worker.recognize(prepared)
  ]);
  const recognizedText = recognition.data.text;
  const recognizedOutcome = /\bWIN\b/i.test(recognizedText)
    ? "win"
    : /\bLOSS\b/i.test(recognizedText)
      ? "loss"
      : outcome;
  return { outcome: recognizedOutcome, names: parseCaptureRows(recognizedText) };
}

async function recognizeAllCaptureScreenshots(attachments) {
  const task = async () => {
    const names = [];
    const outcomes = [];
    for (const attachment of attachments) {
      const result = await recognizeCaptureScreenshot(await downloadDiscordAttachment(attachment));
      names.push(...result.names);
      outcomes.push(result.outcome);
    }
    return { names: [...new Set(names)], outcomes };
  };
  const result = ocrQueue.then(task, task);
  ocrQueue = result.catch(() => null);
  return result;
}

async function matchMpNamesToMembers(guild, names) {
  const members = await listGuildMembers(guild);
  const memberSearchValues = members.filter((member) => !member.user.bot).map((member) => {
    const rawValues = [
      member.displayName,
      member.nickname,
      member.user.globalName,
      member.user.username
    ].filter(Boolean);
    const values = new Set();
    for (const rawValue of rawValues) {
      const normalized = normalizeSearchText(rawValue);
      if (!normalized) continue;
      values.add(normalized);
      for (const token of normalized.split(" ")) {
        if (token.length >= 2 && !/^\d+$/.test(token)) values.add(token);
      }
    }
    const rank = getRankFromMemberRoles(member);
    return { member, values, eligible: rank !== null && rank >= 2 && rank <= 7 };
  });
  const matched = [];
  const unmatched = [];
  for (const name of names) {
    const normalizedName = normalizeSearchText(name);
    const tokens = normalizedName.split(" ").filter(Boolean);
    const fullName = tokens.join(" ");
    const firstName = tokens[0] ?? "";
    const aliases = new Set([fullName, firstName].filter((value) => value.length >= 2));
    const candidates = memberSearchValues.filter(({ values }) =>
      [...aliases].some((alias) => values.has(alias))
    );
    const eligibleCandidates = candidates.filter((candidate) => candidate.eligible);
    if (eligibleCandidates.length === 1) {
      matched.push({ name, userId: eligibleCandidates[0].member.id });
    } else if (eligibleCandidates.length > 1) {
      unmatched.push(`${name} (несколько совпадений)`);
    } else if (!candidates.length) {
      unmatched.push(name);
    }
    // Участники 1-го, 8-го и более высоких рангов намеренно полностью пропускаются.
  }
  const uniqueMatched = [...new Map(matched.map((entry) => [entry.userId, entry])).values()];
  return { matched: uniqueMatched, unmatched: [...new Set(unmatched)] };
}

async function getAfkMembers(guild) {
  const members = await listGuildMembers(guild);

  const mpPoints = getMpPoints();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const inactiveMembers = [];
  let mpPointsChanged = false;

  for (const member of members) {
    if (member.user.bot) continue;

    const rank = getRankFromMemberRoles(member);
    if (rank === null || rank < 1 || rank > 7 || rank === 4) continue;

    if (!mpPoints[member.id]) {
      inactiveMembers.push({ member, rank });
      continue;
    } else if (!("lastAwardAt" in mpPoints[member.id])) {
      const history = Array.isArray(mpPoints[member.id].history) ? mpPoints[member.id].history : [];
      const latestAwardTimestamp = history.reduce((latest, entry) => {
        const createdAt = Date.parse(entry.createdAt);
        return Number(entry.amount) > 0 && Number.isFinite(createdAt)
          ? Math.max(latest, createdAt)
          : latest;
      }, 0);
      mpPoints[member.id].lastAwardAt = latestAwardTimestamp
        ? new Date(latestAwardTimestamp).toISOString()
        : null;
      mpPointsChanged = true;
    }

    const lastAwardTimestamp = Date.parse(mpPoints[member.id].lastAwardAt ?? "");
    if (!Number.isFinite(lastAwardTimestamp) || lastAwardTimestamp < cutoff) {
      inactiveMembers.push({ member, rank });
    }
  }

  if (mpPointsChanged) await saveMpPoints(mpPoints);

  const sortedMembers = inactiveMembers.sort((left, right) =>
    left.rank - right.rank || left.member.displayName.localeCompare(right.member.displayName, "ru")
  );
  return sortedMembers;
}

function buildAfkPage(inactiveMembers, requestedPage, ownerId) {
  const pageCount = Math.max(1, Math.ceil(inactiveMembers.length / 10));
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const entries = inactiveMembers.slice(page * 10, page * 10 + 10);
  const description = entries.length
    ? entries.map(({ member, rank }, index) => `${page * 10 + index + 1}. <@${member.id}> — ${rank} ранг`).join("\n")
    : "Все учитываемые участники получали МП за последние 7 дней.";
  const embed = new EmbedBuilder()
    .setColor(0x79040c)
    .setTitle("AFK за 7 дней")
    .setDescription(description)
    .setFooter({ text: `Страница ${page + 1}/${pageCount} • Всего: ${inactiveMembers.length}` })
    ;

  if (pageCount === 1) return embedToComponentPayload(embed);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`afk_page:${ownerId}:${page - 1}`)
      .setLabel("Назад")
      .setEmoji(applicationEmoji("back"))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`afk_page:${ownerId}:${page + 1}`)
      .setLabel("Вперёд")
      .setEmoji(applicationEmoji("forward"))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === pageCount - 1)
  );

  return embedToComponentPayload(embed, [row]);
}

async function getPromotionCandidates(guild) {
  const members = await listGuildMembers(guild);
  const candidates = [];
  for (const member of members) {
    if (member.user.bot) continue;
    const rank = getRankFromMemberRoles(member);
    if (rank === 1) {
      if (normalizeSearchText(member.displayName).includes("kraken")) {
        candidates.push({ member, rank, nextRank: 2, balance: getMpBalance(member.id), required: 0 });
      }
      continue;
    }
    const requirement = PROMOTION_REQUIREMENTS[rank];
    if (!requirement) continue;
    const balance = getMpBalance(member.id);
    if (balance >= requirement.points) {
      candidates.push({
        member,
        rank,
        nextRank: requirement.nextRank,
        balance,
        required: requirement.points
      });
    }
  }

  candidates.sort((left, right) =>
    left.rank - right.rank || left.member.displayName.localeCompare(right.member.displayName, "ru")
  );
  return candidates;
}

function buildInfoPage(candidates, requestedPage, ownerId) {
  const pageCount = Math.max(1, Math.ceil(candidates.length / 10));
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const entries = candidates.slice(page * 10, page * 10 + 10);
  const description = entries.length
    ? entries.map(({ member, rank, nextRank, balance, required }, index) => {
      const condition = rank === 1
        ? "фамилия Kraken"
        : `${balance}/${required} MP`;
      return `${page * 10 + index + 1}. <@${member.id}> — **${rank} → ${nextRank}** • ${condition}`;
    }).join("\n")
    : "Сейчас нет участников, готовых к повышению по указанным условиям.";
  const embed = new EmbedBuilder()
    .setColor(0x79040c)
    .setTitle("Кандидаты на повышение")
    .setDescription(
      `${description}\n\n*Контракты, взносы и другие дополнительные условия проверяются вручную.*`
    )
    .setFooter({ text: `Страница ${page + 1}/${pageCount} • Всего: ${candidates.length}` });

  if (pageCount === 1) return embedToComponentPayload(embed);
  const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`info_page:${ownerId}:${page - 1}`)
          .setLabel("Назад")
          .setEmoji(applicationEmoji("back"))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`info_page:${ownerId}:${page + 1}`)
          .setLabel("Вперёд")
          .setEmoji(applicationEmoji("forward"))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === pageCount - 1)
      );
  return embedToComponentPayload(embed, [row]);
}

function buildInfoMenu() {
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x79040c)
      .setTitle("Информация о составе")
      .setDescription(
        "Выберите нужный список.\n\n" +
        "**Повышение** — участники, которые набрали необходимое количество баллов для следующего ранга. Дополнительные условия руководство проверяет вручную.\n" +
        "**AFK** — участники, которые не получали MP-баллы последние 7 дней."
      )],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("info_menu:promotion").setLabel("Повышение").setEmoji(applicationEmoji("rank_history")).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("info_menu:afk").setLabel("AFK").setEmoji(applicationEmoji("afk_leave")).setStyle(ButtonStyle.Secondary)
    )]
  };
}

function rankDisplayName(rank, member = null) {
  if (rank === 8) {
    const manualRoleId = rankRoleIdsFor(8)[1];
    const hasManualRole = manualRoleId && member?.roles?.cache?.has(manualRoleId);
    return hasManualRole ? "High Staff (Administrator)" : "High Staff";
  }
  if (rank === 9) return "Deputy Leader";
  if (rank === 10) return "Leader";
  return rank ? String(rank) : "Не в фаме";
}

function rankNicknamePrefix(rank) {
  if (rank === 9) return "Deputy";
  if (rank === 10) return "Leader";
  return String(rank);
}

function formatFamilyNickname(rank, icName, staticId) {
  const normalizedName = String(icName ?? "").trim();
  const normalizedStaticId = String(staticId ?? "").trim();
  if (!rank || !normalizedName || !normalizedStaticId) return null;
  const prefix = `${rankNicknamePrefix(rank)} | `;
  const suffix = ` | ${normalizedStaticId}`;
  const availableNameLength = 32 - prefix.length - suffix.length;
  if (availableNameLength < 1) return null;
  return `${prefix}${normalizedName.slice(0, availableNameLength).trim()}${suffix}`;
}

function buildFamilyNickname(rank, characterInfo) {
  const [icName, , staticId] = String(characterInfo ?? "")
    .split("/")
    .map((part) => part.trim());
  return formatFamilyNickname(rank, icName, staticId);
}

function memberNicknameIdentity(member) {
  const nicknameParts = String(member?.nickname ?? "").split("|").map((part) => part.trim());
  if (nicknameParts.length >= 3) {
    const staticId = nicknameParts.at(-1);
    const icName = nicknameParts.slice(1, -1).join(" | ");
    if (icName && staticId) return { icName, staticId };
  }

  const application = Object.values(getApplications())
    .filter((entry) => entry.userId === member?.id && entry.status === "accepted")
    .sort((a, b) => Date.parse(b.closedAt ?? b.updatedAt ?? 0) - Date.parse(a.closedAt ?? a.updatedAt ?? 0))[0];
  const [icName, , staticId] = String(application?.characterInfo ?? "")
    .split("/")
    .map((part) => part.trim());
  return icName && staticId ? { icName, staticId } : null;
}

async function syncMemberRankNickname(member, rank) {
  const identity = memberNicknameIdentity(member);
  if (!identity) return null;
  const nickname = formatFamilyNickname(rank, identity.icName, identity.staticId);
  if (!nickname) throw new Error("Не удалось сформировать никнейм участника.");
  if (member.nickname !== nickname) {
    await member.setNickname(nickname, `Синхронизация никнейма с ${rank} рангом`);
  }
  return nickname;
}

async function getRankFromUser(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  return getRankFromMemberRoles(member);
}

function getWarnCountFromMemberRoles(member) {
  if (!member?.roles?.cache) return 0;

  for (const warnCount of [2, 1]) {
    const roleId = WARN_ROLE_IDS[warnCount];
    if (roleId && member.roles.cache.has(roleId)) return warnCount;
  }

  return 0;
}

function normalizeWarningsForRole(userId, warnCount, existingWarnings) {
  if (warnCount <= 0) return [];

  const current = Array.isArray(existingWarnings) ? existingWarnings.slice(0, warnCount) : [];
  while (current.length < warnCount) {
    current.push({
      reason: "Синхронизация по роли варна",
      issuedBy: client.user?.id ?? "system",
      issuedAt: new Date().toISOString(),
      synced: true
    });
  }

  return current;
}

async function syncWarningsFromMemberRoles(member) {
  if (!member) return 0;

  const warnCount = getWarnCountFromMemberRoles(member);
  const warnings = getWarnings();
  warnings[member.id] ??= { active: [], history: [] };
  warnings[member.id].active ??= [];
  warnings[member.id].history ??= [];
  warnings[member.id].active = normalizeWarningsForRole(member.id, warnCount, warnings[member.id].active);

  await saveWarnings(warnings);
  return warnCount;
}

async function syncGuildStateFromRoles(guild) {
  const members = await listGuildMembers(guild).catch(() => null);
  if (!members) return;

  const warnings = getWarnings();
  for (const member of members) {
    if (member.user.bot) continue;
    const warnCount = getWarnCountFromMemberRoles(member);
    warnings[member.id] ??= { active: [], history: [] };
    warnings[member.id].active ??= [];
    warnings[member.id].history ??= [];
    warnings[member.id].active = normalizeWarningsForRole(
      member.id,
      warnCount,
      warnings[member.id].active
    );
    await syncUserProfile(member.id, {
      username: member.user.username,
      currentRank: getRankFromMemberRoles(member)
    });
  }
  await saveWarnings(warnings);
  await flushStorage();
}

async function syncWarnRoles(member, warnCount) {
  if (!member) return;

  for (const roleId of Object.values(WARN_ROLE_IDS)) {
    if (roleId && member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId);
    }
  }

  const roleId = WARN_ROLE_IDS[warnCount];
  if (roleId) await member.roles.add(roleId);
}

function applicationTitle(application) {
  return `Заявка на вступление | ${application.uid ?? "без UID"}`;
}

function supportTicketTitle(ticket) {
  return `${supportTypeTitle()} | ${ticket.uid ?? "без UID"}`;
}

function buildApplicationMessagePayload(application) {
  const closed = ["accepted", "rejected", "closed"].includes(application.status);
  const value = (input) => String(input || "Не указано").slice(0, 500);
  const container = new ContainerBuilder()
    .setAccentColor(0x79040c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${applicationTitle(application)}\n` +
        `Статус: **${applicationStatusLabel(application.status)}**\n` +
        `Состав: **${applicationSectionLabel(application.requestType)}**`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Кандидат:** <@${application.userId}>\n` +
        `**Discord ID:** ${application.userId}\n` +
        `**IC имя / уровень / Static ID:** ${value(application.characterInfo)}\n` +
        `**OOC возраст:** ${value(application.oocAge)}\n` +
        (application.requestType === "capt" ? `**Кем хочет быть:** ${value(application.captRole)}\n` : "") +
        `**Почему хочет вступить:** ${value(application.reason)}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${config.leadershipRoleIds.map((roleId) => `<@&${roleId}>`).join(" · ")}`
      )
    );
  if (!closed) container.addActionRowComponents(...applicationButtons(application));
  return {
    content: null,
    embeds: [],
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { roles: [...config.leadershipRoleIds] }
  };
}

function buildApplicationDmEmbed(application, title, description, color, fields = []) {
  return new EmbedBuilder()
    .setColor(0x79040c)
    .setTitle(title)
    .setDescription(description)
    .addFields(fields)
    ;
}

function embedToComponentPayload(embed, actionRows = []) {
  return {
    content: null,
    embeds: [embed],
    components: actionRows,
    allowedMentions: { parse: [], users: [], roles: [] }
  };
}

function buildApplicationPanel() {
  const botInfo = getBotInfo();
  const captOpen = Boolean(botInfo.captRecruitmentOpen);
  const rpOpen = Boolean(botInfo.rpRecruitmentOpen);
  const status = (open) =>
    `${applicationEmojiMention(open ? "unlock" : "lock")} Набор ${open ? "открыт" : "закрыт"}`;
  const recruitmentStatus = !captOpen && !rpOpen
    ? `### Статус набора\n${applicationEmojiMention("lock")} Набор в оба состава закрыт`
    : `### Статус набора\n` +
      `**CAPT-состав:** ${status(captOpen)}\n` +
      `**RP-состав:** ${status(rpOpen)}`;

  const select = new StringSelectMenuBuilder()
    .setCustomId("application:start")
    .setPlaceholder("Подать заявку");
  if (captOpen) {
    select.addOptions({
        label: "Заявка в CAPT-состав",
        description: "ORLANDO / RU18",
        emoji: applicationEmoji("number_1"),
        value: "capt"
    });
  }
  if (rpOpen) {
    select.addOptions({
        label: "Заявка в RP-состав",
        description: "ORLANDO / RU18",
        emoji: applicationEmoji("number_2"),
        value: "rp"
    });
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x79040c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## Оформление заявки в Kraken\n" +
        "Выберите состав и заполните анкету для рассмотрения руководством."
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        recruitmentStatus
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "### Что важно знать перед подачей\n" +
        "• Заявки принимаются только для **Orlando / RU18**.\n" +
        "• Возраст — **от 16 лет**, возможны исключения.\n" +
        "• В среднем анкета рассматривается в течение **24 часов**.\n" +
        "• Если нужный состав недоступен — набор в него временно закрыт."
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "### После подачи заявки\n" +
        "• Заявка будет направлена администрации на рассмотрение.\n" +
        "• Следите за личными сообщениями и не закрывайте ЛС от сервера.\n" +
        "• Отвечайте в анкете развёрнуто — это ускорит рассмотрение."
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "### Повторная подача\n" +
        "После отклонения новую заявку можно подать через **10 дней**."
      )
    );

  if (captOpen || rpOpen) {
    container
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      )
      .addActionRowComponents(new ActionRowBuilder().addComponents(select));
  }

  return {
    content: null,
    embeds: [],
    components: [container],
    flags: MessageFlags.IsComponentsV2
  };
}

function supportTypeTitle() {
  return "Обращение";
}

function supportRequestTypeLabel(type) {
  if (!type) return "Не указано";
  return SUPPORT_REQUEST_TYPES[type] ?? "Неизвестный тип";
}

function buildSupportPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x79040c)
    .setTitle("Личный кабинет")
    .setDescription(
      "Единый раздел для личных функций участника семьи. Здесь можно посмотреть текущий ранг, варны и историю профиля, создать обращение к администрации или открыть AFK-систему.\n\n" +
      "**Личный кабинет** — профиль, баланс и история действий.\n" +
      "**Создать обращение** — направить администрации вопрос или заявку.\n" +
      "**AFK-система** — временно отметить отсутствие в игре и посмотреть активные отчёты."
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("support:profile")
      .setLabel("Личный кабинет")
      .setEmoji(applicationEmoji("profile"))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("support:create")
      .setLabel("Создать обращение")
      .setEmoji(applicationEmoji("create_ticket"))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("support:afk")
      .setLabel("AFK-система")
      .setEmoji(applicationEmoji("afk_leave"))
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

function buildAdminPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x79040c)
    .setTitle("Административная панель")
    .setDescription(
      "Единый рабочий интерфейс руководства семьи. Выберите нужный раздел и действие — бот откроет форму и покажет результат только вам. Массовые действия поддерживают до 10 Discord ID или упоминаний за один раз.\n\n" +
      "**Профиль** — открыть профиль любого участника и посмотреть историю.\n" +
      "**Варны** — выдать или снять предупреждение.\n" +
      "**Ранги** — повысить или понизить участника.\n" +
      "**Баллы** — начислить или списать MP-баллы.\n" +
      "**Составы** — переключить набор в Capt, RP или оба состава."
    );
  const firstRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin:profile").setLabel("Профиль").setEmoji(applicationEmoji("profile")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:warn").setLabel("Варны").setEmoji(applicationEmoji("warnings")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:rank").setLabel("Ранги").setEmoji(applicationEmoji("rank_history")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:mp").setLabel("Баллы").setEmoji(applicationEmoji("mp_history")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:recruitment").setLabel("Составы").setEmoji(applicationEmoji("recruitment")).setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [firstRow] };
}

function buildAdminSection(section) {
  const embed = new EmbedBuilder().setColor(0x79040c);
  if (section === "warn") {
    embed
      .setTitle("Система варнов")
      .setDescription("Выберите действие кнопкой ниже. Можно указать до 10 участников через пробел или с новой строки. При третьем активном варне участник исключается с Discord-сервера.")
      .addFields({
        name: "Доступные наказания для снятия варна",
        value: [
          "• Купить и разгрузить на склад семьи 1250 бинтов.",
          "• Купить и разгрузить на склад семьи 50 лёгких бронежилетов.",
          "• Купить и разгрузить на склад семьи 20 специальных карабинов MK2.",
          "• Купить и разгрузить на склад семьи 20 специальных карабинов MK1.",
          "• Купить и разгрузить на склад семьи 20 тяжёлых винтовок.",
          "• Купить и разгрузить на склад семьи 15 тяжёлых дробовиков.",
          "• Купить и разгрузить на склад семьи 425 аптечек.",
          "• Купить и разгрузить на склад семьи 30 эпинефринов.",
          "• Пополнить баланс семьи на 100 000$."
        ].join("\n")
      });
    return { embed, row: new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_action:warn:add").setLabel("Добавить варн").setEmoji(applicationEmoji("add")).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_action:warn:remove").setLabel("Снять варн").setEmoji(applicationEmoji("remove")).setStyle(ButtonStyle.Secondary)
    ) };
  }
  if (section === "rank") return { embed: embed.setTitle("Система рангов").setDescription("Повышение или понижение изменяет каждого выбранного участника на следующую доступную ступень. Изменение роли, профиль и история синхронизируются автоматически."), row: new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_action:rank:add").setLabel("Повысить").setEmoji(applicationEmoji("add")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_action:rank:remove").setLabel("Понизить").setEmoji(applicationEmoji("remove")).setStyle(ButtonStyle.Secondary)
  ) };
  if (section === "mp") return { embed: embed.setTitle("Система MP-баллов").setDescription("Начисляйте или списывайте одинаковое количество баллов сразу у группы до 10 участников. MP-баллы доступны только участникам со 2-го по 7-й ранг. Результат каждой операции доступен в профиле участника."), row: new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_action:mp:add").setLabel("Добавить").setEmoji(applicationEmoji("add")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_action:mp:remove").setLabel("Списать").setEmoji(applicationEmoji("remove")).setStyle(ButtonStyle.Secondary)
  ) };
  return null;
}

function buildAdminMembersModal(system, action) {
  const history = action === "history" || system === "profile";
  const modal = new ModalBuilder().setCustomId(modalCustomId("admin_modal", system, action)).setTitle(history ? "Выбор участника" : "Управление участниками");
  const members = new TextInputBuilder().setCustomId("members").setLabel(history ? "Discord ID или упоминание" : "Discord ID или упоминания (до 10)").setStyle(history ? TextInputStyle.Short : TextInputStyle.Paragraph).setRequired(true).setMaxLength(history ? 32 : 400);
  modal.addComponents(new ActionRowBuilder().addComponents(members));
  if (history) return modal;
  if (system === "mp") modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amount").setLabel("Количество баллов").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)));
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Причина").setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(2).setMaxLength(500)));
  return modal;
}

async function resolveAdminMembers(guild, input, limit = 10) {
  const ids = [...new Set(String(input).match(/\d{17,20}/g) ?? [])].slice(0, limit);
  const members = await Promise.all(ids.map((id) => (
    guild.members.cache.get(id) ?? guild.members.fetch(id).catch(() => null)
  )));
  return members.filter(Boolean);
}

function buildAdminRecruitmentPayload() {
  const botInfo = getBotInfo();
  const select = new StringSelectMenuBuilder()
    .setCustomId("admin_recruitment_select")
    .setPlaceholder("Выберите состав")
    .addOptions(
      { label: "Capt", value: "capt", description: `Сейчас набор ${botInfo.captRecruitmentOpen ? "открыт" : "закрыт"}` },
      { label: "RP", value: "rp", description: `Сейчас набор ${botInfo.rpRecruitmentOpen ? "открыт" : "закрыт"}` },
      { label: "Оба состава", value: "both", description: "Переключить Capt и RP одновременно" }
    );
  return {
    embeds: [new EmbedBuilder().setColor(0x79040c).setTitle("Управление составами").setDescription("Выберите Capt, RP или оба состава. После выбора бот покажет текущее действие и запросит подтверждение.")],
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral
  };
}

function gameAfkTimestamp(value, style = "R") {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? `<t:${Math.floor(milliseconds / 1000)}:${style}>`
    : "время не определено";
}

const AFK_LOOKUP_TIMEOUT = Symbol("afk-lookup-timeout");

async function getGameAfkSessionQuick(userId, timeoutMs = 750) {
  let timer;
  try {
    return await Promise.race([
      getGameAfkSession(userId).catch(() => AFK_LOOKUP_TIMEOUT),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(AFK_LOOKUP_TIMEOUT), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildGameAfkPanel(sessions = []) {
  const activeList = sessions.length
    ? sessions.map((session) =>
      `• <@${session.userId}> — вернётся ${gameAfkTimestamp(session.expiresAt)} (${gameAfkTimestamp(session.expiresAt, "t")})`
    ).join("\n")
    : "Никто сейчас не в AFK.";

  const embed = new EmbedBuilder()
    .setColor(0x79040c)
    .setTitle("AFK-система")
    .setDescription(
      "Используйте AFK-систему, если вы **остаётесь в игре**, но временно отходите от компьютера. Нажмите **«Уйти в AFK»**, укажите причину и время отсутствия. В панели будет видно только время возвращения, а причина сохранится в логах администрации.\n\n" +
      "Если вернулись раньше — нажмите **«Вернуться из AFK»**. По окончании времени бот автоматически уберёт вас из списка и отправит уведомление в ЛС."
    )
    .addFields({ name: "Сейчас в AFK", value: activeList });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("game_afk:start")
      .setLabel("Уйти в AFK")
      .setEmoji(applicationEmoji("afk_leave"))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("game_afk:return")
      .setLabel("Вернуться из AFK")
      .setEmoji(applicationEmoji("afk_return"))
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    content: null,
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [], users: [], roles: [] }
  };
}

function buildGameAfkModal() {
  const modal = new ModalBuilder()
    .setCustomId(modalCustomId("game_afk", "start-submit"))
    .setTitle("Уйти в AFK");
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Причина")
    .setPlaceholder("Кратко укажите, почему вы отходите")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(2)
    .setMaxLength(500)
    .setRequired(true);
  const duration = new TextInputBuilder()
    .setCustomId("duration")
    .setLabel("Длительность в часах (максимум 4)")
    .setPlaceholder("Например: 1 или 0,5")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(4)
    .setRequired(true);
  modal.addComponents(
    new ActionRowBuilder().addComponents(reason),
    new ActionRowBuilder().addComponents(duration)
  );
  return modal;
}

function parseYoutubeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["youtube.com", "www.youtube.com", "youtu.be", "www.youtu.be"].includes(url.hostname.toLowerCase())) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function captReplayWindowExpiresAt(window) {
  const openedAtMs = Date.parse(window.openedAt ?? "");
  return Number.isFinite(openedAtMs) ? openedAtMs + CAPT_REPLAY_WINDOW_MS : null;
}

function isCaptReplayWindowOpen(window) {
  const expiresAt = captReplayWindowExpiresAt(window);
  return Boolean(window.isOpen) && expiresAt !== null && Date.now() < expiresAt;
}

function buildCaptReplayPanel(window) {
  const open = isCaptReplayWindowOpen(window);
  const expiresAt = captReplayWindowExpiresAt(window);
  const embed = new EmbedBuilder()
    .setColor(0x79040c)
    .setDescription(
      "### Как это работает\n" +
      "• Приём откатов открывается на **90 минут**.\n" +
      "• Пока приём открыт, кнопка «Загрузить откат» ниже активна — нажмите её и пришлите ссылку.\n" +
      "• Ссылка должна вести на **YouTube** (youtube.com или youtu.be), другие сайты не принимаются.\n" +
      "• За одно открытие каждый участник может отправить **только один откат** — повторная " +
      "отправка в это же окно будет отклонена.\n\n" +
      "### После отправки\n" +
      "Бот создаёт под этим сообщением отдельную ветку и публикует туда каждый присланный " +
      "откат — так руководству удобно рассматривать их все в одном месте.\n\n" +
      (open
        ? `**Приём открыт до ${discordTimestampFromMs(expiresAt)}.**`
        : "**Приём сейчас закрыт.**")
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("capt_replay:upload")
      .setLabel("Загрузить откат")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!open)
  );
  return { content: null, embeds: [embed], components: [row] };
}

async function hasSubmittedCaptReplay(thread, userId) {
  if (!thread) return false;
  const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return false;
  return messages.some((message) => message.embeds[0]?.footer?.text === userId);
}

function buildCaptReplayModal() {
  const modal = new ModalBuilder()
    .setCustomId(modalCustomId("capt_replay", "submit"))
    .setTitle("Загрузить откат");
  const url = new TextInputBuilder()
    .setCustomId("url")
    .setLabel("Ссылка на YouTube")
    .setPlaceholder("https://youtu.be/...")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(url));
  return modal;
}

function buildApplicationModal(section) {
  const modal = new ModalBuilder()
    .setCustomId(modalCustomId("family_application", section))
    .setTitle(`Заявка в ${applicationSectionLabel(section)}`);

  const character = new TextInputBuilder()
    .setCustomId("character")
    .setLabel("IC имя / уровень персонажа / Static ID")
    .setPlaceholder("Например: John_Smith / 50 / 12345")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const oocAge = new TextInputBuilder()
    .setCustomId("ooc_age")
    .setLabel("OOC возраст")
    .setPlaceholder("Укажите ваш реальный возраст")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Почему хотите вступить?")
    .setPlaceholder("Расскажите, почему выбрали Kraken и чем будете полезны фаме")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  const captRole = new StringSelectMenuBuilder()
    .setCustomId("capt_role")
    .setPlaceholder("Выберите Collers или Main")
    .setRequired(true)
    .addOptions(
      { label: "Collers", value: "Collers" },
      { label: "Main", value: "Main" }
    );

  modal.addComponents(
    new ActionRowBuilder().addComponents(character),
    new ActionRowBuilder().addComponents(oocAge),
    new ActionRowBuilder().addComponents(reason)
  );
  if (section === "capt") {
    modal.addComponents(
      new LabelBuilder()
        .setLabel("Кем хотите быть?")
        .setStringSelectMenuComponent(captRole)
    );
  }

  return modal;
}

function buildApplicationRejectionModal(uid) {
  const modal = new ModalBuilder()
    .setCustomId(modalCustomId("application", "reject-reason", uid))
    .setTitle("Отклонить заявку");
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Причина отклонения")
    .setPlaceholder("Укажите причину, по которой заявка отклонена")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(reason));
  return modal;
}

function buildSupportCreateModal(nonce) {
  const modal = new ModalBuilder()
    .setCustomId(`support:create-submit:${nonce}`)
    .setTitle("Создать обращение");
  const typeSelect = new StringSelectMenuBuilder()
    .setCustomId(`request_type:${nonce}`)
    .setPlaceholder("Выберите тип заявки")
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      Object.entries(SUPPORT_REQUEST_TYPES).map(([value, label]) => ({ label, value }))
    );
  const details = new TextInputBuilder()
    .setCustomId(`details:${nonce}`)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Подробно опишите вашу заявку")
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(4000);
  modal.addComponents(
    new LabelBuilder()
      .setLabel("Тип заявки")
      .setDescription("Выберите один подходящий вариант")
      .setStringSelectMenuComponent(typeSelect),
    new LabelBuilder()
      .setLabel("Детали заявки")
      .setDescription("Укажите всю информацию, необходимую администрации")
      .setTextInputComponent(details)
  );
  return modal;
}

function buildTicketTransferModal(scope, uid) {
  const modal = new ModalBuilder()
    .setCustomId(modalCustomId("ticket", "transfer-target", scope, uid))
    .setTitle("Передать заявку");
  const target = new TextInputBuilder()
    .setCustomId("target")
    .setLabel("Кому передать")
    .setPlaceholder("Discord ID, упоминание или точный ник")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(target));
  return modal;
}

async function setApplicantCanWrite(channel, userId, canWrite) {
  // Discord threads do not support per-user permission overwrites. Membership
  // controls visibility; once a ticket is claimed, only its three participants
  // remain in the private thread.
  if (channel.isThread()) return;

  if (!canWrite) {
    await channel.permissionOverwrites.edit(userId, applicantLockedOverwriteOptions());
    return;
  }

  await channel.permissionOverwrites.edit(userId, {
    ViewChannel: true,
    SendMessages: true,
    AttachFiles: true,
    CreatePublicThreads: true,
    CreatePrivateThreads: true,
    SendMessagesInThreads: true,
    UseApplicationCommands: true,
    ReadMessageHistory: true
  });
}

async function closeApplicationThread(channel, reason) {
  if (!channel?.isThread()) return false;
  try {
    await channel.edit({ archived: true, locked: true }, reason);
    return true;
  } catch (error) {
    console.error(`Failed to close application thread ${channel.id}:`, error);
  }

  try {
    if (!channel.archived) await channel.setArchived(true, reason);
    if (!channel.locked) await channel.setLocked(true, reason);
    return true;
  } catch (error) {
    console.error(`Failed to close application thread ${channel.id} using fallback:`, error);
    return false;
  }
}

async function addTicketThreadMembers(thread, userIds) {
  await Promise.allSettled(
    [...new Set(userIds.filter(Boolean))].map(async (userId) => {
      const member = await thread.guild.members.fetch(userId).catch(() => null);
      if (!member || thread.members.cache.has(userId)) return;
      await thread.members.add(userId).catch((error) => {
        if (error.code !== 50001 && error.code !== 10007) {
          console.error(`Failed to add ${userId} to ticket thread ${thread.id}:`, error);
        }
      });
    })
  );
}

async function keepOnlyTicketParticipants(thread, userIds) {
  if (!thread?.isThread()) return;
  const keep = new Set(userIds.filter(Boolean));
  keep.add(thread.client.user.id);
  const members = await thread.members.fetch().catch((error) => {
    console.error(`Failed to fetch members of ticket thread ${thread.id}:`, error);
    return null;
  });

  if (members) {
    await Promise.allSettled(
      members
        .filter((member) => !keep.has(member.id))
        .map((member) =>
          thread.members.remove(member.id).catch((error) => {
            console.error(`Failed to remove ${member.id} from ticket thread ${thread.id}:`, error);
          })
        )
    );
  }

  await addTicketThreadMembers(thread, [...keep]);
}

async function ensureTicketReviewerParentAccess(parent, reviewerRoleIds) {
  await Promise.all(reviewerRoleIds.map(async (roleId) => {
    const permissions = parent.permissionsFor(roleId);
    if (
      permissions?.has(PermissionFlagsBits.ViewChannel) &&
      permissions?.has(PermissionFlagsBits.ManageThreads)
    ) return;
    await parent.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessagesInThreads: true,
      ManageThreads: true
    });
  }));
}

async function createPrivateTicketThread(interaction, name, reviewerRoleIds = config.leadershipRoleIds) {
  const parent = interaction.channel;
  if (!parent?.isTextBased() || !parent.threads) {
    throw new Error("Панель заявок должна находиться в обычном текстовом канале с поддержкой веток.");
  }

  await ensureTicketReviewerParentAccess(parent, reviewerRoleIds);

  const thread = await parent.threads.create({
    name,
    type: ChannelType.PrivateThread,
    // The creator must be allowed to populate the private thread. Invitations
    // are disabled again immediately after the applicant has been added.
    invitable: true,
    autoArchiveDuration: 10080,
    reason: `Приватная заявка от ${interaction.user.tag} (${interaction.user.id})`
  });
  return thread;
}

async function createApplicationChannel(interaction, uid) {
  return createPrivateTicketThread(interaction, uid);
}

async function refreshApplicationPanel(guild) {
  const channel = await guild.channels.fetch(APPLICATION_PANEL_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) return null;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const panels = messages?.filter((message) => {
    if (message.author.id !== guild.client.user.id) return false;
    const serialized = JSON.stringify(message.components);
    return serialized.includes("application:start") ||
      serialized.toLowerCase().includes("оформление заявки в kraken");
  });
  const current = panels?.first() ?? null;
  const duplicates = panels?.filter((message) => message.id !== current?.id) ?? [];
  await Promise.allSettled(duplicates.map((message) => message.delete()));
  if (current) {
    const updated = await current.edit(buildApplicationPanel()).catch(() => null);
    if (updated) return updated;
    await current.delete().catch(() => null);
  }
  return channel.send(buildApplicationPanel());
}

async function refreshStaticPanel(guild, channelId, componentId, payloadBuilder) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const current = messages?.find((message) =>
    message.author.id === guild.client.user.id &&
    JSON.stringify(message.components).includes(componentId)
  );
  if (current) {
    const updated = await current.edit(payloadBuilder()).catch(() => null);
    if (updated) return updated;
    await current.delete().catch(() => null);
  }
  return channel.send(payloadBuilder());
}

async function processExpiredGameAfkSessions(clientInstance) {
  const expired = await takeExpiredGameAfkSessions();
  if (!expired.length) return;
  const guild = await clientInstance.guilds.fetch(process.env.DISCORD_GUILD_ID).catch(() => null);
  if (!guild) return;

  for (const session of expired) {
    const user = await clientInstance.users.fetch(session.userId).catch(() => null);
    if (user) {
      await user.send({
        embeds: [new EmbedBuilder()
          .setColor(0x79040c)
          .setTitle("Время AFK завершилось")
          .setDescription("Указанное вами время AFK истекло. Вы автоматически удалены из списка AFK.")],
        allowedMentions: { parse: [], users: [], roles: [] }
      }).catch(() => null);
    }
    await sendLog(guild, new EmbedBuilder()
      .setColor(0xf2c94c)
      .setTitle("AFK завершён автоматически")
      .setDescription(`<@${session.userId}> автоматически удалён из списка AFK.`)
      .addFields(
        { name: "Причина", value: String(session.reason).slice(0, 1024) },
        { name: "Начало", value: gameAfkTimestamp(session.startedAt, "F"), inline: true },
        { name: "Завершение", value: gameAfkTimestamp(session.expiresAt, "F"), inline: true }
      ));
  }
}

async function openCaptReplayWindow(guild, adminId) {
  const openedAt = new Date().toISOString();
  await saveCaptReplayWindow({ isOpen: true, openedAt, openedBy: adminId, threadId: null });
  const panelMessage = await refreshStaticPanel(
    guild,
    CAPT_REPLAY_CHANNEL_ID,
    "capt_replay:upload",
    () => buildCaptReplayPanel(getCaptReplayWindow())
  );
  let threadId = null;
  if (panelMessage) {
    const thread = await panelMessage.startThread({
      name: `Откаты CAPT — ${new Date(openedAt).toLocaleDateString("ru-RU")}`,
      autoArchiveDuration: 1440,
      reason: `Приём откатов открыт: ${adminId}`
    }).catch((error) => {
      console.error("Failed to create capt replay thread:", error);
      return null;
    });
    threadId = thread?.id ?? null;
    if (thread) {
      const recentMessages = await panelMessage.channel.messages.fetch({ limit: 5 }).catch(() => null);
      const threadNotice = recentMessages?.find((message) => message.type === MessageType.ThreadCreated);
      await threadNotice?.delete().catch(() => null);
    }
  }
  const finalWindow = { isOpen: true, openedAt, openedBy: adminId, threadId };
  await saveCaptReplayWindow(finalWindow);
  return finalWindow;
}

async function closeCaptReplayWindow(guild, window) {
  if (window.threadId) {
    const thread = await guild.channels.fetch(window.threadId).catch(() => null);
    if (thread?.isThread()) {
      await thread.delete("Приём откатов закрыт").catch(() => null);
    }
  }
  await saveCaptReplayWindow({ ...window, isOpen: false, threadId: null });
  await refreshStaticPanel(
    guild,
    CAPT_REPLAY_CHANNEL_ID,
    "capt_replay:upload",
    () => buildCaptReplayPanel(getCaptReplayWindow())
  );
}

async function processCaptReplayExpiry(clientInstance) {
  const window = getCaptReplayWindow();
  if (!window.isOpen) return;
  const expiresAt = captReplayWindowExpiresAt(window);
  if (expiresAt === null || Date.now() < expiresAt) return;

  const guild = await clientInstance.guilds.fetch(process.env.DISCORD_GUILD_ID).catch(() => null);
  if (!guild) return;
  await closeCaptReplayWindow(guild, window);
  await sendLog(guild, new EmbedBuilder()
    .setColor(0xf2c94c)
    .setTitle("Приём откатов CAPT закрыт автоматически")
    .setDescription("Истекло время окна приёма откатов (1 час 30 минут)."));
}

function buildSupportTicketMessagePayload(ticket, user) {
  const statusLabels = {
    new: "Новая",
    in_review: "На рассмотрении",
    approved: "Закрыто",
    rejected: "Закрыто",
    closed: "Закрыто"
  };
  const closed = ["closed", "approved", "rejected"].includes(ticket.status);
  const reviewerMention = ticket.status === "new"
    ? ` | ${config.leadershipRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")}`
    : "";
  const container = new ContainerBuilder()
    .setAccentColor(0x79040c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${supportTicketTitle(ticket)}\n` +
        `Статус: **${statusLabels[ticket.status] ?? "Неизвестно"}**${reviewerMention}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Заявитель:** ${user ? `${user.tag} · ` : ""}<@${ticket.userId}>\n` +
        `**Тип заявки:** ${supportRequestTypeLabel(ticket.requestType)}\n\n` +
        `**Детали:**\n${String(ticket.details ?? "Не указаны").slice(0, 3000)}`
      )
    );
  if (!closed) {
    container.addActionRowComponents(...supportTicketButtons(ticket));
  }
  return {
    content: null,
    embeds: [],
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { roles: [...config.leadershipRoleIds] }
  };
}

async function createSupportTicketChannel(interaction, ticket) {
  return createPrivateTicketThread(
    interaction,
    ticket.uid
  );
}

async function createGeneralSupportTicket(interaction, requestType, details) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const tickets = getSupportTickets();
  const activeTicket = Object.values(tickets).find(
    (ticket) => ticket.userId === interaction.user.id &&
      ["new", "in_review"].includes(ticket.status)
  );
  if (activeTicket) {
    const existingChannel = activeTicket.channelId
      ? await interaction.guild.channels.fetch(activeTicket.channelId).catch(() => null)
      : null;
    await interaction.editReply({
      content: existingChannel
        ? `У вас уже есть активное обращение: ${existingChannel}.`
        : "У вас уже есть активное обращение. Дождитесь ответа администрации."
    });
    return;
  }

  await interaction.editReply({
    content: loadingMessage("Пожалуйста, подождите, ваше обращение создаётся...")
  });
  const uid = createTicketUid("S", tickets, getApplications());
  const ticketId = `${interaction.user.id}-${Date.now()}`;
  const ticket = {
    id: ticketId,
    uid,
    userId: interaction.user.id,
    status: "new",
    requestType,
    details,
    channelId: null,
    messageId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const channel = await createSupportTicketChannel(interaction, ticket);
  ticket.channelId = channel.id;
  tickets[ticketId] = ticket;
  await saveSupportTickets(tickets);

  const message = await channel.send(buildSupportTicketMessagePayload(ticket, interaction.user));
  ticket.messageId = message.id;
  tickets[ticketId] = ticket;
  await saveSupportTickets(tickets);

  await addTicketThreadMembers(channel, [interaction.user.id]);
  await channel.setInvitable(false, "Все участники обращения добавлены").catch(() => null);
  await interaction.editReply({ content: successMessage(`Обращение создано! ${channel}`) });
  await dmUserEmbed(
    interaction.user,
    buildApplicationDmEmbed(
      ticket,
      "Обращение создано",
      `Обращение создано и направлено администрации. Ожидайте ответа.\n\nОткрыть обращение: ${channel}`,
      0x56ccf2
    )
  );
  await sendLog(
    interaction.guild,
    new EmbedBuilder()
      .setColor(0x79040c)
      .setTitle(`Новое обращение | ${uid}`)
      .setDescription(
        `<@${interaction.user.id}> создал обращение.\n` +
        `Тип: **${supportRequestTypeLabel(requestType)}**\nВетка: ${channel}`
      )
  );
}

async function dmUser(user, payload) {
  if (!user) return;
  if (!getUserRecord(user.id).dmNotifications) return;
  return user.send(payload).catch(() => null);
}

async function dmUserEmbed(user, embed) {
  await dmUser(user, {
    embeds: [embed],
    allowedMentions: { parse: [], users: [], roles: [] }
  });
}

async function deleteApplicationAnnouncement(guild, application) {
  if (!application?.announcementChannelId || !application?.announcementMessageId) return true;

  const channel = await guild.channels.fetch(application.announcementChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const message = await channel.messages.fetch(application.announcementMessageId).catch(() => null);
  if (!message) return true;
  return message.delete().then(() => true).catch((error) => {
    console.error(`Failed to delete application announcement ${application.announcementMessageId}:`, error);
    return false;
  });
}

async function deleteApplicationChannels(guild, application) {
  if (!application) return;
  await deleteApplicationAnnouncement(guild, application);

  const ticketThread = application.channelId
    ? await guild.channels.fetch(application.channelId).catch(() => null)
    : null;
  if (ticketThread?.isThread()) {
    await ticketThread.delete("Пользователь покинул Discord-сервер").catch(() => null);
    return;
  }

  if (ticketThread) await ticketThread.delete("Очистка закрытой заявки").catch(() => null);
}

async function deleteSupportTicketChannels(guild, ticket) {
  if (!ticket) return;

  const ticketThread = ticket.channelId
    ? await guild.channels.fetch(ticket.channelId).catch(() => null)
    : null;
  if (ticketThread?.isThread()) {
    await ticketThread.delete("Пользователь покинул Discord-сервер").catch(() => null);
    return;
  }

  if (ticketThread) await ticketThread.delete("Служебная заявка закрыта").catch(() => null);
}

async function synchronizeStoredTicketThreads(guild) {
  const applications = getApplications();
  let applicationsChanged = false;
  for (const application of Object.values(applications)) {
    const isClosed = ["closed", "accepted", "rejected"].includes(application.status);
    if (isClosed && (application.announcementChannelId || application.announcementMessageId)) {
      const removed = await deleteApplicationAnnouncement(guild, application);
      if (removed) {
        application.announcementChannelId = null;
        application.announcementMessageId = null;
        applicationsChanged = true;
      }
    }
    if (!application.channelId) continue;
    const channel = await guild.channels.fetch(application.channelId).catch(() => null);
    if (!channel?.isThread()) continue;

    if (!channel.archived && application.uid && channel.name !== application.uid) {
      await channel.setName(application.uid, "Единый формат номера заявки").catch(() => null);
    }
    if (application.messageId) {
      const message = await channel.messages.fetch(application.messageId).catch(() => null);
      if (message) {
        const user = await guild.client.users.fetch(application.userId).catch(() => null);
        await message.edit(buildApplicationMessagePayload(application, user)).catch(() => null);
      }
    }
    if (isClosed && (!channel.archived || !channel.locked)) {
      await closeApplicationThread(channel, "Заявка уже закрыта");
    }
  }
  if (applicationsChanged) await saveApplications(applications);

  for (const ticket of Object.values(getSupportTickets())) {
    if (!ticket.channelId) continue;
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (!channel?.isThread()) continue;
    if (ticket.messageId) {
      const message = await channel.messages.fetch(ticket.messageId).catch(() => null);
      const user = await guild.client.users.fetch(ticket.userId).catch(() => null);
      if (message) {
        await message.edit(buildSupportTicketMessagePayload(ticket, user)).catch(() => null);
      }
    }
    if (["approved", "rejected", "closed"].includes(ticket.status) && (!channel.archived || !channel.locked)) {
      await closeApplicationThread(channel, "Обращение уже обработано");
    }
  }
}

async function sendLog(guild, embed) {
  if (!config.logChannelId) return;
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (channel?.isTextBased()) {
    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [], users: [], roles: [] }
    });
  }
}

function memberEmbed(user, rank, warnCount, member = null) {
  const embed = new EmbedBuilder()
    .setColor(0x79040c)
    .setTitle(`Профиль: ${user.username}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: "Discord", value: `<@${user.id}>`, inline: true },
      { name: "Ранг", value: rankDisplayName(rank, member), inline: true },
      { name: "Варны", value: String(warnCount), inline: true }
    );
  if (!isMpPointsExcludedRank(rank)) {
    embed.addFields({ name: "Баланс баллов МП", value: String(getMpBalance(user.id)), inline: true });
  }
  return embed;
}

async function handleClientReady(readyClient) {
  console.log(`Бот запущен как ${readyClient.user.tag}`);
  await updateBotOnlineStatus(readyClient);
  setInterval(() => {
    updateBotOnlineStatus(readyClient).catch((error) => {
      console.error("Failed to schedule Orlando online status update:", error);
    });
  }, BOT_STATUS_UPDATE_INTERVAL_MS);
  const guildId = process.env.DISCORD_GUILD_ID;
  const guild = guildId ? await readyClient.guilds.fetch(guildId).catch(() => null) : null;
  if (guild) {
    await processExpiredGameAfkSessions(readyClient);
    const applicationParent = await guild.channels.fetch(APPLICATION_PANEL_CHANNEL_ID).catch(() => null);
    if (applicationParent?.isTextBased()) {
      await ensureTicketReviewerParentAccess(applicationParent, config.leadershipRoleIds);
      await refreshApplicationPanel(guild);
    }
    await refreshStaticPanel(guild, SUPPORT_PANEL_CHANNEL_ID, "support:create", buildSupportPanel);
    await refreshStaticPanel(guild, ADMIN_PANEL_CHANNEL_ID, "admin:warn", buildAdminPanel);
    await refreshStaticPanel(
      guild,
      CAPT_REPLAY_CHANNEL_ID,
      "capt_replay:upload",
      () => buildCaptReplayPanel(getCaptReplayWindow())
    );
    await syncGuildStateFromRoles(guild);
    await synchronizeStoredTicketThreads(guild);
  }
  const gameAfkSweep = setInterval(() => {
    processExpiredGameAfkSessions(readyClient).catch((error) => {
      console.error("Failed to process expired AFK sessions:", error);
    });
  }, GAME_AFK_SWEEP_INTERVAL_MS);
  gameAfkSweep.unref?.();

  const captReplaySweep = setInterval(() => {
    processCaptReplayExpiry(readyClient).catch((error) => {
      console.error("Failed to process capt replay window expiry:", error);
    });
  }, CAPT_REPLAY_SWEEP_INTERVAL_MS);
  captReplaySweep.unref?.();

  // Periodically (rather than before every single interaction) pick up data changed
  // directly in the database, so manual edits still apply without a restart but without
  // adding a blocking MySQL round-trip in front of every button/command's 3-second ack window.
  const storageReloadSweep = setInterval(() => {
    reloadStorage().catch((error) => {
      console.error("Background storage reload failed:", error);
    });
  }, STORAGE_RELOAD_INTERVAL_MS);
  storageReloadSweep.unref?.();
}

client.once(Events.ClientReady, (readyClient) => {
  handleClientReady(readyClient).catch((error) => {
    console.error("Bot initialization after login failed:", error);
  });
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

async function claimTicketFromActivity(channel, reviewer) {
  if (!channel?.isThread() || reviewer.bot) return false;
  const reviewerMember = channel.guild.members.cache.get(reviewer.id) ??
    await channel.guild.members.fetch(reviewer.id).catch(() => null);
  const applications = getApplications();
  const applicationEntry = Object.entries(applications).find(
    ([, application]) => application.channelId === channel.id && application.status === "new"
  );

  if (applicationEntry) {
    if (!isApplicationReviewer(reviewerMember)) return false;
    const [applicationKey, application] = applicationEntry;
    application.status = "in_review";
    application.claimedBy = reviewer.id;
    application.updatedAt = new Date().toISOString();
    applications[applicationKey] = application;
    await saveApplications(applications);

    const user = channel.client.users.cache.get(application.userId) ??
      await channel.client.users.fetch(application.userId).catch(() => null);
    const ticketMessage = application.messageId
      ? await channel.messages.fetch(application.messageId).catch(() => null)
      : null;

    if (ticketMessage) {
      await ticketMessage.edit(buildApplicationMessagePayload(application, user)).catch(() => null);
    }

    if (channel.name !== application.uid) {
      await channel.setName(application.uid, "Единый формат номера заявки").catch(() => null);
    }
    await channel.send(`Администратор <@${reviewer.id}> приступил к рассмотрению заявки **${application.uid}**.`);
    await sendLog(
      channel.guild,
      new EmbedBuilder()
        .setColor(0x2f80ed)
        .setTitle(`Заявка взята в работу | ${application.uid}`)
        .setDescription(`<@${reviewer.id}> взял заявку <@${application.userId}>.`)
    );
    await dmUserEmbed(
      user,
      buildApplicationDmEmbed(
        application,
        "Заявка взята в работу",
        `Администратор <@${reviewer.id}> приступил к рассмотрению вашей заявки.\n\nОткрыть заявку: ${channel}`,
        0x2f80ed
      )
    );
    await keepOnlyTicketParticipants(channel, [
      application.userId,
      reviewer.id,
      channel.client.user.id
    ]);
    return true;
  }

  const tickets = getSupportTickets();
  const ticketEntry = Object.entries(tickets).find(
    ([, ticket]) => ticket.channelId === channel.id && ticket.status === "new"
  );
  if (!ticketEntry) return false;
  if (!isSupportReviewer(reviewerMember)) return false;

  const [ticketId, ticket] = ticketEntry;
  ticket.status = "in_review";
  ticket.claimedBy = reviewer.id;
  ticket.updatedAt = new Date().toISOString();
  tickets[ticketId] = ticket;
  await saveSupportTickets(tickets);

  const user = channel.client.users.cache.get(ticket.userId) ??
    await channel.client.users.fetch(ticket.userId).catch(() => null);
  const ticketMessage = ticket.messageId
    ? await channel.messages.fetch(ticket.messageId).catch(() => null)
    : null;

  if (ticketMessage) {
    await ticketMessage.edit(buildSupportTicketMessagePayload(ticket, user)).catch(() => null);
  }

  await channel.send(`Администратор <@${reviewer.id}> приступил к рассмотрению обращения **${ticket.uid}**.`);
  await sendLog(
    channel.guild,
    new EmbedBuilder()
      .setColor(0x79040c)
      .setTitle(`Обращение взято в работу | ${ticket.uid}`)
      .setDescription(`<@${reviewer.id}> взял обращение <@${ticket.userId}>.`)
  );
  await dmUserEmbed(
    user,
    new EmbedBuilder()
      .setColor(0x79040c)
      .setTitle(`Обращение ${ticket.uid} взято в работу`)
      .setDescription(`Администратор <@${reviewer.id}> приступил к рассмотрению вашего обращения.\n\nОткрыть обращение: ${channel}`)
  );
  await keepOnlyTicketParticipants(channel, [
    ticket.userId,
    reviewer.id,
    channel.client.user.id
  ]);
  await setApplicantCanWrite(channel, ticket.userId, true);
  return true;
}

function buildMpReviewPayload(request) {
  request.matched ??= [];
  request.unmatched ??= [];
  const countWarning = Number.isFinite(request.declaredCount) && request.declaredCount !== request.matched.length
    ? `\n${applicationEmojiMention("warnings")} В форме указано **${request.declaredCount}**, в итоговом списке **${request.matched.length}**.`
    : "";
  const embed = new EmbedBuilder()
    .setColor(0x79040c)
    .setTitle("Проверка начисления баллов МП")
    .setDescription(
      `Отправитель: <@${request.submittedBy}>\n` +
      `Вид МП: **${request.eventLabel}**\n` +
      `Начисление: **${request.points} баллов каждому**\n` +
      `Скриншотов обработано: **${request.screenshotUrls.length}**${countWarning}`
    )
    .addFields(
      {
        name: "Итоговый список участников",
        value: request.matched.map((entry) => `• **${entry.name}** → <@${entry.userId}>`).join("\n").slice(0, 1024) || "Никого"
      },
      {
        name: "Не удалось сопоставить",
        value: request.unmatched.map((name) => `• ${name}`).join("\n").slice(0, 1024) || "Нет"
      },
      { name: "Исходное сообщение", value: request.sourceUrl }
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mpocr:approve:${request.id}`).setLabel("Подтвердить").setEmoji(applicationEmoji("confirm")).setStyle(ButtonStyle.Secondary).setDisabled(!request.matched.length),
    new ButtonBuilder().setCustomId(`mpocr:reject:${request.id}`).setLabel("Отклонить").setEmoji(applicationEmoji("cancel")).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mpocr:actions:${request.id}`).setLabel("Другие действия").setEmoji(applicationEmoji("menu")).setStyle(ButtonStyle.Secondary)
  );
  if (request.status !== "pending") {
    embed.addFields({
      name: "Решение",
      value: request.status === "approved"
        ? `Подтверждено <@${request.reviewedBy}>. Начислено участникам: **${request.awardedUserIds?.length ?? 0}**.`
        : `Отклонено <@${request.reviewedBy}>.`
    });
    return embedToComponentPayload(embed);
  }
  return embedToComponentPayload(embed, [row]);
}

function mpEventOptionLabel(event) {
  return `${event.label} — ${event.points} баллов`;
}

function buildMpOtherActionsPayload(request) {
  return {
    content: `${applicationEmojiMention("menu")} | Выберите дополнительное действие:`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mpocr:add:${request.id}`)
        .setLabel("Добавить пользователей")
        .setEmoji(applicationEmoji("add"))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`mpocr:exclude:${request.id}`)
        .setLabel("Исключить пользователей")
        .setEmoji(applicationEmoji("remove"))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!request.matched.length),
      new ButtonBuilder()
        .setCustomId(`mpocr:type:${request.id}`)
        .setLabel("Изменить вид МП")
        .setEmoji(applicationEmoji("edit"))
        .setStyle(ButtonStyle.Secondary)
    )],
    flags: MessageFlags.Ephemeral
  };
}

function buildMpTypeSelectPayload(request) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`mpocr_type_select:${request.id}`)
    .setPlaceholder("Выберите вид МП")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(MP_EVENT_TYPES.map((event) => ({
      label: mpEventOptionLabel(event),
      value: event.key,
      default: event.key === request.eventKey
    })));
  return {
    content: "Выберите правильный вид МП:",
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral
  };
}

function buildMpTypeConfirmationPayload(requestId, event) {
  return {
    content: `Вы уверены, что хотите изменить вид МП на **${mpEventOptionLabel(event)}**?`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mpocr:type-confirm:${requestId}:${event.key}`)
        .setLabel("Подтвердить")
        .setEmoji(applicationEmoji("confirm"))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`mpocr:type-cancel:${requestId}`)
        .setLabel("Отменить")
        .setEmoji(applicationEmoji("cancel"))
        .setStyle(ButtonStyle.Secondary)
    )],
    flags: MessageFlags.Ephemeral
  };
}

const MP_REPORT_REACTION_NAMES = ["pending", "confirm", "cancel"];

async function setMpReportReaction(message, reactionName) {
  for (const name of MP_REPORT_REACTION_NAMES) {
    const emoji = applicationEmoji(name);
    const currentReaction = message.reactions.cache.get(emoji.id);
    if (currentReaction?.me) {
      await currentReaction.users.remove(message.client.user.id).catch(() => null);
    }
  }
  if (reactionName) {
    await message.react(applicationEmojiReaction(reactionName));
  }
}

async function replyMpReportError(message, text) {
  await setMpReportReaction(message, "cancel").catch(() => null);
  await message.reply(text).catch(() => null);
}

async function replaceMpReportStatus(client, request, reactionName) {
  const channel = await client.channels.fetch(request.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  if (request.ackMessageId) {
    const acknowledgement = await channel.messages.fetch(request.ackMessageId).catch(() => null);
    if (acknowledgement) await acknowledgement.delete().catch(() => null);
  }
  const sourceMessage = await channel.messages.fetch(request.messageId).catch(() => null);
  if (sourceMessage) {
    await setMpReportReaction(sourceMessage, reactionName).catch(() => null);
  }
}

async function editMpReviewMessage(client, request) {
  if (!request.reviewMessageId) return;
  const reviewer = await client.users.fetch(MP_REPORT_REVIEWER_ID).catch(() => null);
  const dm = await reviewer?.createDM().catch(() => null);
  const message = await dm?.messages.fetch(request.reviewMessageId).catch(() => null);
  if (!message) return;
  if (message.flags.has(MessageFlags.IsComponentsV2)) {
    const replacement = await dm.send(buildMpReviewPayload(request)).catch(() => null);
    if (!replacement) return;
    request.reviewMessageId = replacement.id;
    const requests = getMpRequests();
    if (requests[request.id]) {
      requests[request.id].reviewMessageId = replacement.id;
      await saveMpRequests(requests);
    }
    await message.delete().catch(() => null);
    return;
  }
  await message.edit(buildMpReviewPayload(request)).catch(() => null);
}

async function handleMpReportMessage(message) {
  await setMpReportReaction(message, "pending").catch(() => null);
  const { type, declaredCount } = parseMpReport(message.content);
  const attachments = [...message.attachments.values()].filter((attachment) =>
    attachment.contentType?.startsWith("image/") || /\.(?:png|jpe?g|webp)$/i.test(attachment.name ?? "")
  );

  if (!type || !attachments.length) {
    await replyMpReportError(
      message,
      "Не удалось проверить форму, сверьтесь с порядком заполнения в закреплённом сообщение."
    );
    return;
  }

  try {
    let recognizedNames;
    if (type.key === "capture_win" || type.key === "capture_loss") {
      const capture = await recognizeAllCaptureScreenshots(attachments);
      const expectedOutcome = type.key === "capture_win" ? "win" : "loss";
      if (capture.outcomes.some((outcome) => outcome && outcome !== expectedOutcome)) {
        await replyMpReportError(
          message,
          "Не удалось подтвердить указанный результат капта. Проверьте, что выбран верный тип — удачный или неудачный захват — и приложен полный скриншот с отметкой WIN/LOSS."
        );
        return;
      }
      recognizedNames = capture.names;
      if (!recognizedNames.length) {
        await replyMpReportError(message, "На скриншоте не найдены участники с уроном больше нуля.");
        return;
      }
    } else {
      recognizedNames = await recognizeAllMpScreenshots(attachments);
      if (!recognizedNames.length) {
        await replyMpReportError(
          message,
          "Не удалось распознать участников на скриншоте. Проверьте, что список группы полностью виден, и отправьте заявку повторно."
        );
        return;
      }
    }
    const { matched, unmatched } = await matchMpNamesToMembers(message.guild, recognizedNames);
    const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const requests = getMpRequests();
    requests[requestId] = {
      id: requestId,
      guildId: message.guild.id,
      channelId: message.channel.id,
      messageId: message.id,
      submittedBy: message.author.id,
      eventKey: type.key,
      eventLabel: type.label,
      points: type.points,
      declaredCount,
      recognizedNames,
      matched,
      unmatched,
      screenshotUrls: attachments.map((attachment) => attachment.url),
      sourceUrl: message.url,
      status: "pending",
      createdAt: new Date().toISOString()
    };
    await saveMpRequests(requests);

    const reviewer = await message.client.users.fetch(MP_REPORT_REVIEWER_ID).catch(() => null);
    const reviewMessage = await dmUser(reviewer, buildMpReviewPayload(requests[requestId]));
    if (reviewMessage) {
      requests[requestId].reviewMessageId = reviewMessage.id;
      await saveMpRequests(requests);
    }
    await sendLog(
      message.guild,
      new EmbedBuilder()
        .setColor(0x56ccf2)
        .setTitle("Заявка на начисление MP создана")
        .setDescription(`<@${message.author.id}> отправил отчёт **${type.label}**.`)
        .addFields(
          { name: "Участников распознано", value: String(matched.length), inline: true },
          { name: "Баллов каждому", value: String(type.points), inline: true },
          { name: "Исходное сообщение", value: message.url }
        )
    );
  } catch (error) {
    console.error("MP OCR processing failed:", error);
    await replyMpReportError(
      message,
      "Не удалось обработать заявку. Проверьте форму и вложения, затем отправьте её повторно."
    );
    const reviewer = await message.client.users.fetch(MP_REPORT_REVIEWER_ID).catch(() => null);
    await dmUser(reviewer, {
      content: `Не удалось обработать заявку МП от <@${message.author.id}>: ${error.message ?? error}\n${message.url}`
    });
  }
}

async function handleMessageCreate(message) {
  if (!message.guild || message.author.bot) return;
  const isMpReport = message.channel.id === MP_REPORT_CHANNEL_ID;
  if (!isMpReport && !message.channel.isThread()) return;

  if (isMpReport) {
    await handleMpReportMessage(message);
    return;
  }
  await reloadStorage();
  if (message.channel.isThread()) await claimTicketFromActivity(message.channel, message.author);
}

client.on(Events.MessageCreate, (message) => {
  handleMessageCreate(message).catch((error) => {
    console.error("Message processing failed:", error);
  });
});

async function handleMessageReactionAdd(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  if (reaction.message.partial) await reaction.message.fetch().catch(() => null);
  const channel = reaction.message.channel;
  if (!channel?.isThread()) return;
  await reloadStorage();
  await claimTicketFromActivity(channel, user);
}

client.on(Events.MessageReactionAdd, (reaction, user) => {
  handleMessageReactionAdd(reaction, user).catch((error) => {
    console.error("Reaction processing failed:", error);
  });
});

async function purgeDepartedUser(guild, userId) {
  await reloadStorage();
  const applications = getApplications();
  const supportTickets = getSupportTickets();

  for (const application of Object.values(applications).filter((item) => item.userId === userId)) {
    await deleteApplicationChannels(guild, application);
  }

  for (const ticket of Object.values(supportTickets).filter((item) => item.userId === userId)) {
    await deleteSupportTicketChannels(guild, ticket);
  }

  await deleteUserProfile(userId);
}

async function handleGuildMemberRemove(member) {
  await purgeDepartedUser(member.guild, member.id);
}

client.on(Events.GuildMemberRemove, (member) => {
  handleGuildMemberRemove(member).catch((error) => {
    console.error("Guild member removal processing failed:", error);
  });
});

client.on(Events.GuildBanAdd, (ban) => {
  purgeDepartedUser(ban.guild, ban.user.id).catch((error) => {
    console.error("Guild ban user cleanup failed:", error);
  });
});

async function handleGuildMemberAdd(member) {
  await reloadStorage();
  if (member.user.bot) return;
  await syncUserProfile(member.id, {
    username: member.user.username,
    currentRank: getRankFromMemberRoles(member)
  });
  clearMemberMpPoints(member.id);
  await syncWarningsFromMemberRoles(member);
  await flushStorage();
}

client.on(Events.GuildMemberAdd, (member) => {
  handleGuildMemberAdd(member).catch((error) => {
    console.error("Guild member addition processing failed:", error);
  });
});

async function handleGuildMemberUpdate(oldMember, newMember) {
  const oldRank = getRankFromMemberRoles(oldMember);
  const newRank = getRankFromMemberRoles(newMember);
  if (oldRank === newRank) return;
  if ((botRankChanges.get(newMember.id) ?? 0) > Date.now()) return;
  await reloadStorage();

  const auditLogs = await newMember.guild.fetchAuditLogs({
    type: AuditLogEvent.MemberRoleUpdate,
    limit: 6
  }).catch(() => null);
  const auditEntry = auditLogs?.entries.find((entry) =>
    entry.target?.id === newMember.id && Date.now() - entry.createdTimestamp < 15_000
  );
  if (auditEntry?.executor?.id === newMember.client.user.id) return;

  const syncedNickname = await syncMemberRankNickname(newMember, newRank).catch((error) => {
    console.error(`Failed to synchronize nickname for ${newMember.id}:`, error);
    return null;
  });
  await addUserAudit(newMember.id, "rank", {
    oldRank,
    newRank,
    adminId: auditEntry?.executor?.id ?? "system",
    reason: "Ранг изменён вручную через роли Discord"
  });
  await sendLog(
    newMember.guild,
    new EmbedBuilder()
      .setColor(0xf2c94c)
      .setTitle("Ранг изменён через роли Discord")
      .setDescription(`<@${newMember.id}>: **${oldRank ?? "нет"} → ${newRank ?? "нет"}**.`)
      .addFields({
        name: "Администратор",
        value: auditEntry?.executor?.id ? `<@${auditEntry.executor.id}>` : "Не удалось определить",
        inline: true
      }, {
        name: "Никнейм",
        value: syncedNickname ?? "Не изменён: IC-имя или Static ID не найдены"
      })
  );
}

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  handleGuildMemberUpdate(oldMember, newMember).catch((error) => {
    console.error("Guild member update processing failed:", error);
  });
});

async function handleInteraction(interaction) {
  if (interaction.isButton() && interaction.customId.startsWith("action-cancel:")) {
    const id = interaction.customId.slice("action-cancel:".length);
    const pending = pendingConfirmations.get(id);
    if (!pending || pending.ownerId !== interaction.user.id) {
      await interaction.deferUpdate().catch(() => null);
      return;
    }
    pendingConfirmations.delete(id);
    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => null);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("action-confirm:")) {
    const id = interaction.customId.slice("action-confirm:".length);
    const pending = pendingConfirmations.get(id);
    if (!pending || pending.ownerId !== interaction.user.id || pending.expiresAt < Date.now()) {
      pendingConfirmations.delete(id);
      await interaction.update({ content: noticeMessage("Время подтверждения истекло."), components: [] }).catch(() => null);
      return;
    }
    pendingConfirmations.delete(id);
    try {
      await handleInteraction(confirmedInteraction(pending.interaction, interaction));
    } catch (error) {
      console.error("Confirmed interaction processing failed:", error);
      await interaction.editReply({
        content: errorMessage("Не удалось выполнить действие из-за внутренней ошибки. Попробуйте ещё раз."),
        components: []
      }).catch(() => null);
    }
    return;
  }
  if (interaction.isButton() && interaction.customId === "game_afk:return" && !interaction._confirmed) {
    const current = await getGameAfkSessionQuick(interaction.user.id);
    if (current !== AFK_LOOKUP_TIMEOUT && (!current || Date.parse(current.expiresAt) <= Date.now())) {
      if (current) {
        void removeGameAfkSession(interaction.user.id);
      }
      await interaction.reply({
        content: noticeMessage("Вы сейчас не находитесь в AFK."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  }

  const confirmation = confirmationText(interaction);
  if (confirmation) {
    await requestActionConfirmation(interaction, confirmation);
    return;
  }

  if (interaction.isButton() && interaction.customId === "game_afk:start") {
    const current = await getGameAfkSessionQuick(interaction.user.id);
    if (current !== AFK_LOOKUP_TIMEOUT && current && Date.parse(current.expiresAt) > Date.now()) {
      await interaction.reply({
        content: noticeMessage(`Вы уже находитесь в AFK и вернётесь ${gameAfkTimestamp(current.expiresAt)}.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (current && current !== AFK_LOOKUP_TIMEOUT) void removeGameAfkSession(interaction.user.id);
    await interaction.showModal(buildGameAfkModal());
    return;
  }

  if (interaction.isButton() && interaction.customId === "game_afk:return") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const session = await removeGameAfkSession(interaction.user.id);
    if (!session) {
      await interaction.editReply({ content: noticeMessage("Вы сейчас не находитесь в AFK.") });
      return;
    }
    const activeSessions = await getActiveGameAfkSessions();
    await interaction.editReply(buildGameAfkPanel(activeSessions));
    await sendLog(interaction.guild, new EmbedBuilder()
      .setColor(0x27ae60)
      .setTitle("Пользователь вернулся из AFK")
      .setDescription(`<@${interaction.user.id}> самостоятельно вернулся из AFK.`)
      .addFields(
        { name: "Причина", value: String(session.reason).slice(0, 1024) },
        { name: "Начало", value: gameAfkTimestamp(session.startedAt, "F"), inline: true },
        { name: "Планировалось до", value: gameAfkTimestamp(session.expiresAt, "F"), inline: true }
      ));
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("game_afk:start-submit:")) {
    await interaction.deferUpdate();
    const reason = interaction.fields.getTextInputValue("reason").trim();
    const hours = Number(interaction.fields.getTextInputValue("duration").trim().replace(",", "."));
    if (!Number.isFinite(hours) || hours <= 0 || hours > GAME_AFK_MAX_HOURS) {
      await interaction.editReply({
        content: errorMessage("Укажите длительность больше 0 и не более 4 часов, например: 1 или 0,5.")
      });
      return;
    }
    const current = await getGameAfkSession(interaction.user.id);
    if (current && Date.parse(current.expiresAt) > Date.now()) {
      await interaction.editReply({
        content: noticeMessage(`Вы уже находитесь в AFK и вернётесь ${gameAfkTimestamp(current.expiresAt)}.`)
      });
      return;
    }
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + hours * 60 * 60 * 1000);
    await saveGameAfkSession({
      userId: interaction.user.id,
      reason,
      startedAt,
      expiresAt
    });
    const activeSessions = await getActiveGameAfkSessions();
    await interaction.editReply(buildGameAfkPanel(activeSessions));
    await sendLog(interaction.guild, new EmbedBuilder()
      .setColor(0x2f80ed)
      .setTitle("Пользователь ушёл в AFK")
      .setDescription(`<@${interaction.user.id}> ушёл в AFK до ${gameAfkTimestamp(expiresAt.toISOString(), "F")}.`)
      .addFields(
        { name: "Причина", value: reason.slice(0, 1024) },
        { name: "Длительность", value: `${hours} ч.`, inline: true }
      ));
    return;
  }

  if (interaction.isChatInputCommand()) {
    const commandName = interaction.commandName;

    if (["info", "move", "capts"].includes(commandName) && !isLeadership(interaction.member)) {
      await interaction.reply({ content: noticeMessage("Эту команду может использовать только руководство фамы."), flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === "move") {
      const source = interaction.options.getChannel("from", true);
      const destination = interaction.options.getChannel("to", true);

      if (source.type !== ChannelType.GuildVoice || destination.type !== ChannelType.GuildVoice) {
        await interaction.reply({
          content: "Нужно выбрать два обычных голосовых канала.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (source.id === destination.id) {
        await interaction.reply({
          content: "Исходный и целевой каналы должны отличаться.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const botMember = interaction.guild.members.me;
      if (
        !botMember?.permissionsIn(source).has(PermissionFlagsBits.MoveMembers) ||
        !botMember.permissionsIn(destination).has(PermissionFlagsBits.Connect)
      ) {
        await interaction.reply({
          content: "У бота недостаточно прав для перемещения участников между этими каналами.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply({
        content: loadingMessage("Пожалуйста, подождите, участники перемещаются...")
      });
      const members = [...source.members.values()];
      let moved = 0;
      const failed = [];

      for (const member of members) {
        try {
          await member.voice.setChannel(
            destination,
            `/move: ${interaction.user.tag} (${interaction.user.id})`
          );
          moved += 1;
        } catch {
          failed.push(member.id);
        }
      }

      const result = [
        `Перемещено из ${source} в ${destination}: **${moved}/${members.length}**.`
      ];
      if (failed.length) {
        result.push(`Не удалось переместить: ${failed.map((id) => `<@${id}>`).join(", ")}.`);
      }
      await sendLog(
        interaction.guild,
        new EmbedBuilder()
          .setColor(0x2f80ed)
          .setTitle("Перемещение голосового канала")
          .setDescription(`<@${interaction.user.id}> переместил участников из ${source} в ${destination}.`)
          .addFields(
            { name: "Результат", value: `${moved}/${members.length}`, inline: true },
            { name: "Не перемещены", value: failed.length ? failed.map((id) => `<@${id}>`).join(", ").slice(0, 1024) : "Нет" }
          )
      );
      await interaction.editReply({ content: successMessage(result.join("\n")) });
      return;
    }

    if (commandName === "info") {
      await interaction.reply({ ...buildInfoMenu(), flags: MessageFlags.Ephemeral });
      return;
    }

    if (commandName === "capts") {
      const window = getCaptReplayWindow();
      const nextOpen = !isCaptReplayWindowOpen(window);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (!nextOpen) {
        await closeCaptReplayWindow(interaction.guild, window);
        await sendLog(
          interaction.guild,
          new EmbedBuilder()
            .setColor(0xeb5757)
            .setTitle("Приём откатов CAPT закрыт")
            .setDescription(`<@${interaction.user.id}> закрыл приём откатов.`)
        );
        await interaction.editReply({ content: successMessage("Приём откатов закрыт.") });
        return;
      }

      const finalWindow = await openCaptReplayWindow(interaction.guild, interaction.user.id);
      const expiresAt = captReplayWindowExpiresAt(finalWindow);
      await sendLog(
        interaction.guild,
        new EmbedBuilder()
          .setColor(0x27ae60)
          .setTitle("Приём откатов CAPT открыт")
          .setDescription(`<@${interaction.user.id}> открыл приём откатов.`)
      );
      await interaction.editReply({
        content: finalWindow.threadId
          ? successMessage(`Приём откатов открыт до ${discordTimestampFromMs(expiresAt)}.`)
          : noticeMessage("Приём открыт, но не удалось создать ветку для откатов — проверьте права бота в канале.")
      });
      return;
    }

  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("mpocr_type_select:")) {
    if (interaction.user.id !== MP_REPORT_REVIEWER_ID) {
      await interaction.reply({ content: noticeMessage("Эта проверка доступна только назначенному администратору."), flags: MessageFlags.Ephemeral });
      return;
    }
    const requestId = interaction.customId.slice("mpocr_type_select:".length);
    const request = getMpRequests()[requestId];
    const event = MP_EVENT_TYPES.find((entry) => entry.key === interaction.values[0]);
    if (!request || request.status !== "pending" || !event) {
      await interaction.update({ content: noticeMessage("Эта заявка уже обработана или не найдена."), components: [] });
      return;
    }
    const confirmationPayload = buildMpTypeConfirmationPayload(requestId, event);
    delete confirmationPayload.flags;
    await interaction.update(confirmationPayload);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("mpocr:")) {
    if (interaction.user.id !== MP_REPORT_REVIEWER_ID) {
      await interaction.reply({ content: noticeMessage("Эта проверка доступна только назначенному администратору."), flags: MessageFlags.Ephemeral });
      return;
    }

    const [, action, requestId, selectedEventKey] = interaction.customId.split(":");
    const requests = getMpRequests();
    const request = requests[requestId];
    if (!request || request.status !== "pending") {
      await interaction.reply({ content: noticeMessage("Эта заявка уже обработана или не найдена."), flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === "actions") {
      await interaction.reply(buildMpOtherActionsPayload(request));
      return;
    }

    if (action === "type") {
      const payload = buildMpTypeSelectPayload(request);
      if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
        delete payload.flags;
        await interaction.update(payload);
      } else {
        await interaction.reply(payload);
      }
      return;
    }

    if (action === "type-cancel") {
      await interaction.deferUpdate();
      await interaction.deleteReply().catch(() => null);
      return;
    }

    if (action === "type-confirm") {
      const event = MP_EVENT_TYPES.find((entry) => entry.key === selectedEventKey);
      if (!event) {
        await interaction.update({ content: errorMessage("Выбранный вид МП не найден."), components: [] });
        return;
      }
      const previousLabel = request.eventLabel;
      request.eventKey = event.key;
      request.eventLabel = event.label;
      request.points = event.points;
      requests[requestId] = request;
      await saveMpRequests(requests);
      await editMpReviewMessage(interaction.client, request);
      const requestGuild = await interaction.client.guilds.fetch(request.guildId).catch(() => null);
      if (requestGuild) {
        await sendLog(
          requestGuild,
          new EmbedBuilder()
            .setColor(0x2f80ed)
            .setTitle("Изменён вид МП")
            .setDescription(`<@${interaction.user.id}> изменил вид МП в заявке <@${request.submittedBy}>.`)
            .addFields(
              { name: "Было", value: previousLabel ?? "Не указано", inline: true },
              { name: "Стало", value: mpEventOptionLabel(event), inline: true },
              { name: "Исходный отчёт", value: request.sourceUrl }
            )
        );
      }
      await interaction.update({ content: successMessage(`Вид МП изменён: ${mpEventOptionLabel(event)}.`), components: [] });
      return;
    }

    if (action === "exclude" || action === "add") {
      const modal = new ModalBuilder()
        .setCustomId(modalCustomId("mpocr_edit", action, requestId))
        .setTitle(action === "exclude" ? "Исключить участников" : "Добавить участников");
      const people = new TextInputBuilder()
        .setCustomId("people")
        .setLabel(action === "exclude" ? "Имена, упоминания или Discord ID" : "Имена, упоминания или Discord ID")
        .setPlaceholder("По одному в строке или через запятую")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(people));
      await interaction.showModal(modal);
      return;
    }

    await interaction.deferUpdate();
    if (action === "reject") {
      request.status = "rejected";
      request.reviewedBy = interaction.user.id;
      request.reviewedAt = new Date().toISOString();
      requests[requestId] = request;
      await saveMpRequests(requests);
      const requestGuild = await interaction.client.guilds.fetch(request.guildId).catch(() => null);
      if (requestGuild) {
        await sendLog(
          requestGuild,
          new EmbedBuilder()
            .setColor(0xeb5757)
            .setTitle("Начисление MP отклонено")
            .setDescription(`<@${interaction.user.id}> отклонил заявку <@${request.submittedBy}>.`)
            .addFields({ name: "Мероприятие", value: request.eventLabel ?? "Не указано" })
        );
      }
      await interaction.message.edit(buildMpReviewPayload(request));
      await replaceMpReportStatus(interaction.client, request, "cancel");
      await interaction.editReply({
        content: successMessage("Заявка на начисление баллов отклонена!"),
        components: []
      });
      return;
    }

    const eligibilityGuild = interaction.guild ??
      await interaction.client.guilds.fetch(request.guildId).catch(() => null);
    const eligibleMatched = [];
    const eligibleMembers = new Map();
    for (const entry of request.matched) {
      const member = await eligibilityGuild?.members.fetch(entry.userId).catch(() => null);
      if (!member || isMpPointsExcludedMember(member)) continue;
      eligibleMatched.push(entry);
      eligibleMembers.set(entry.userId, member);
    }
    const uniqueMembers = [...new Map(eligibleMatched.map((entry) => [entry.userId, entry])).values()];
    const awardedLines = [];
    for (const entry of uniqueMembers) {
      const result = await changeMpBalance(
        entry.userId,
        request.points,
        interaction.user.id,
        `Автоматическое начисление: ${request.eventLabel}`,
        eligibleMembers.get(entry.userId)
      );
      awardedLines.push(`<@${entry.userId}> — начислено **${request.points}**, баланс: **${result.balance}**`);
      const user = await interaction.client.users.fetch(entry.userId).catch(() => null);
      await dmUser(user, {
        embeds: [
          new EmbedBuilder()
            .setColor(0x27ae60)
            .setTitle("Начислены баллы МП")
            .setDescription(`За **${request.eventLabel}** вам начислено **${request.points} баллов МП**.`)
            .addFields(
              { name: "Текущий баланс", value: String(result.balance), inline: true },
              { name: "Администратор", value: `<@${interaction.user.id}>`, inline: true }
            )
        ]
      });
    }

    request.status = "approved";
    request.reviewedBy = interaction.user.id;
    request.reviewedAt = new Date().toISOString();
    request.awardedUserIds = uniqueMembers.map((entry) => entry.userId);
    requests[requestId] = request;
    await saveMpRequests(requests);
    const guild = await interaction.client.guilds.fetch(request.guildId).catch(() => null);
    if (guild) {
      const participantFields = [];
      let participantPage = "";
      for (const line of awardedLines) {
        if (participantPage && participantPage.length + line.length + 1 > 1024) {
          participantFields.push(participantPage);
          participantPage = "";
        }
        participantPage += `${participantPage ? "\n" : ""}${line}`;
      }
      if (participantPage) participantFields.push(participantPage);
      await sendLog(
        guild,
        new EmbedBuilder()
          .setColor(0x27ae60)
          .setTitle("Начисление баллов МП")
          .setDescription(`<@${interaction.user.id}> подтвердил автоматическое начисление баллов участникам МП.`)
          .addFields(
            { name: "Причина", value: request.eventLabel },
            ...participantFields.map((value, index) => ({
              name: participantFields.length > 1 ? `Участники ${index + 1}/${participantFields.length}` : "Участники",
              value
            })),
            { name: "Исходный отчёт", value: request.sourceUrl }
          )
      );
    }
    await interaction.message.edit(buildMpReviewPayload(request));
    await replaceMpReportStatus(interaction.client, request, "confirm");
    await interaction.editReply({
      content: successMessage("Баллы МП начислены участникам!"),
      components: []
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("profile:")) {
    const [, action, ownerId, targetId, rawPage] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "Эти кнопки принадлежат автору команды.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === "mp") {
      await interaction.deferUpdate();
      const targetMember = interaction.guild.members.cache.get(targetId)
        ?? await interaction.guild.members.fetch(targetId).catch(() => null);
      if (isMpPointsExcludedMember(targetMember)) {
        await interaction.editReply({ content: noticeMessage("Для участников 8 ранга и выше учёт баллов МП отключён."), components: [] });
        return;
      }
    } else {
      await interaction.deferUpdate();
    }

    if (["mp", "warn", "rank"].includes(action)) {
      const page = Number.parseInt(rawPage, 10);
      await interaction.editReply(buildProfileHistory(action, targetId, ownerId, Number.isFinite(page) ? page : 0));
      return;
    }

    if (action === "notify") {
      if (ownerId !== targetId) {
        await interaction.editReply(embedToComponentPayload(
          new EmbedBuilder().setDescription(noticeMessage("Настройку уведомлений может менять только владелец профиля."))
        ));
        return;
      }
      const updatedRecord = await updateUserRecord(targetId, (record) => {
        record.dmNotifications = !record.dmNotifications;
      });
      await sendLog(
        interaction.guild,
        new EmbedBuilder()
          .setColor(updatedRecord.dmNotifications ? 0x27ae60 : 0xeb5757)
          .setTitle("Личные уведомления изменены")
          .setDescription(`<@${targetId}> **${updatedRecord.dmNotifications ? "включил" : "выключил"}** уведомления бота.`)
      );
    }

    const target = await interaction.client.users.fetch(targetId).catch(() => interaction.user);
    const member = await interaction.guild.members.fetch(targetId).catch(() => null);
    const rank = getRankFromMemberRoles(member);
    const warnCount = await syncWarningsFromMemberRoles(member);
    await interaction.editReply(embedToComponentPayload(
      memberEmbed(target, rank, warnCount, member),
      [profileButtons(ownerId, targetId, rank)]
    ));
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("afk_page:")) {
    const [, ownerId, rawPage] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: noticeMessage("Переключать страницы может только автор команды."), flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();
    const inactiveMembers = await getAfkMembers(interaction.guild);
    const requestedPage = Number.parseInt(rawPage, 10);
    await interaction.editReply(buildAfkPage(inactiveMembers, Number.isFinite(requestedPage) ? requestedPage : 0, ownerId));
    return;
  }

  if (interaction.isButton() && interaction.customId === "info_menu:promotion") {
    if (!isLeadership(interaction.member)) {
      await interaction.reply({ content: noticeMessage("Этот список доступен только руководству семьи."), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    const candidates = await getPromotionCandidates(interaction.guild);
    await interaction.editReply(buildInfoPage(candidates, 0, interaction.user.id));
    return;
  }

  if (interaction.isButton() && interaction.customId === "info_menu:afk") {
    if (!isLeadership(interaction.member)) {
      await interaction.reply({ content: noticeMessage("Этот список доступен только руководству семьи."), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    const inactiveMembers = await getAfkMembers(interaction.guild);
    await interaction.editReply(buildAfkPage(inactiveMembers, 0, interaction.user.id));
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("info_page:")) {
    const [, ownerId, rawPage] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      await interaction.reply({
        content: noticeMessage("Переключать страницы может только автор команды."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferUpdate();
    const candidates = await getPromotionCandidates(interaction.guild);
    const requestedPage = Number.parseInt(rawPage, 10);
    await interaction.editReply(
      buildInfoPage(candidates, Number.isFinite(requestedPage) ? requestedPage : 0, ownerId)
    );
    return;
  }

  if (interaction.isButton() && interaction.customId === "support:create") {
    const nonce = crypto.randomBytes(6).toString("hex");
    await interaction.showModal(buildSupportCreateModal(nonce));
    return;
  }

  if (interaction.isButton() && interaction.customId === "support:profile") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const rank = getRankFromMemberRoles(member);
    const warnCount = await syncWarningsFromMemberRoles(member);
    await interaction.editReply(embedToComponentPayload(
      memberEmbed(interaction.user, rank, warnCount, member),
      [profileButtons(interaction.user.id, interaction.user.id, rank)]
    ));
    return;
  }

  if (interaction.isButton() && interaction.customId === "support:afk") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const previousPanel = activeAfkPanels.get(interaction.user.id);
    activeAfkPanels.set(interaction.user.id, interaction);
    if (previousPanel && previousPanel !== interaction) {
      await previousPanel.deleteReply().catch(() => null);
    }
    const sessions = await getActiveGameAfkSessions();
    if (activeAfkPanels.get(interaction.user.id) !== interaction) {
      await interaction.deleteReply().catch(() => null);
      return;
    }
    await interaction.editReply(buildGameAfkPanel(sessions));
    return;
  }

  if (interaction.isButton() && interaction.customId === "capt_replay:upload") {
    const window = getCaptReplayWindow();
    if (!isCaptReplayWindowOpen(window)) {
      await interaction.reply({ content: noticeMessage("Приём откатов сейчас закрыт."), flags: MessageFlags.Ephemeral });
      return;
    }
    const thread = window.threadId
      ? await interaction.guild.channels.fetch(window.threadId).catch(() => null)
      : null;
    if (await hasSubmittedCaptReplay(thread, interaction.user.id)) {
      await interaction.reply({ content: noticeMessage("Вы уже отправили откат в этом открытии. Дождитесь следующего."), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(buildCaptReplayModal());
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("capt_replay:submit:")) {
    const window = getCaptReplayWindow();
    if (!isCaptReplayWindowOpen(window)) {
      await interaction.reply({ content: noticeMessage("Приём откатов уже закрыт."), flags: MessageFlags.Ephemeral });
      return;
    }
    const rawUrl = interaction.fields.getTextInputValue("url").trim();
    const parsedUrl = parseYoutubeUrl(rawUrl);
    if (!parsedUrl) {
      await interaction.reply({ content: errorMessage("Укажите корректную ссылку на YouTube."), flags: MessageFlags.Ephemeral });
      return;
    }
    const thread = window.threadId
      ? await interaction.guild.channels.fetch(window.threadId).catch(() => null)
      : null;
    if (!thread?.isThread()) {
      await interaction.reply({ content: errorMessage("Не удалось найти ветку для откатов. Обратитесь к руководству."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (await hasSubmittedCaptReplay(thread, interaction.user.id)) {
      await interaction.reply({ content: noticeMessage("Вы уже отправили откат в этом открытии. Дождитесь следующего."), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await thread.send({
      embeds: [new EmbedBuilder()
        .setColor(0x79040c)
        .setTitle("Новый откат!")
        .setDescription(`Отправитель: <@${interaction.user.id}>\nСсылка: ${rawUrl}`)
        .setFooter({ text: interaction.user.id })
        .setTimestamp()],
      allowedMentions: { parse: [], users: [], roles: [] }
    }).catch(() => null);
    await interaction.editReply({ content: successMessage("Откат отправлен!") });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("admin:")) {
    if (!isLeadership(interaction.member)) {
      await interaction.reply({ content: noticeMessage("Административная панель доступна только руководству семьи."), flags: MessageFlags.Ephemeral });
      return;
    }
    const section = interaction.customId.slice("admin:".length);
    if (section === "profile") {
      await interaction.showModal(buildAdminMembersModal("profile", "view"));
      return;
    }
    if (section === "recruitment") {
      await interaction.reply(buildAdminRecruitmentPayload());
      return;
    }
    if (!["warn", "rank", "mp"].includes(section)) {
      await interaction.reply({ content: errorMessage("Раздел административной панели не найден."), flags: MessageFlags.Ephemeral });
      return;
    }
    const panel = buildAdminSection(section);
    await interaction.reply({ embeds: [panel.embed], components: [panel.row], flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("admin_action:")) {
    if (!isLeadership(interaction.member)) {
      await interaction.reply({ content: noticeMessage("Это действие доступно только руководству семьи."), flags: MessageFlags.Ephemeral });
      return;
    }
    const [, system, action] = interaction.customId.split(":");
    if (!["warn", "rank", "mp"].includes(system) || !["add", "remove"].includes(action)) {
      await interaction.reply({ content: errorMessage("Действие административной панели не найдено."), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(buildAdminMembersModal(system, action));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "admin_recruitment_select") {
    if (!isLeadership(interaction.member)) {
      await interaction.reply({ content: noticeMessage("Это действие доступно только руководству семьи."), flags: MessageFlags.Ephemeral });
      return;
    }
    const section = interaction.values[0];
    const botInfo = getBotInfo();
    const currentlyOpen = section === "capt" ? botInfo.captRecruitmentOpen : section === "rp" ? botInfo.rpRecruitmentOpen : botInfo.captRecruitmentOpen && botInfo.rpRecruitmentOpen;
    const nextOpen = !currentlyOpen;
    const sectionText = section === "both" ? "оба состава" : applicationSectionLabel(section);
    await interaction.update({
      content: `Вы уверены, что хотите **${nextOpen ? "открыть" : "закрыть"}** набор в ${sectionText}?`,
      embeds: [],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`recruitment:confirm:${section}:${nextOpen ? 1 : 0}`).setLabel("Подтвердить").setEmoji(applicationEmoji("confirm")).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("recruitment:cancel").setLabel("Отменить").setEmoji(applicationEmoji("cancel")).setStyle(ButtonStyle.Secondary)
      )]
    });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("admin_modal:")) {
    if (!isLeadership(interaction.member)) {
      await interaction.reply({ content: noticeMessage("Это действие доступно только руководству семьи."), flags: MessageFlags.Ephemeral });
      return;
    }
    const [, system, action] = interaction.customId.split(":");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const members = await resolveAdminMembers(interaction.guild, interaction.fields.getTextInputValue("members"), action === "history" || system === "profile" ? 1 : 10);
    if (!members.length) {
      await interaction.editReply({ content: errorMessage("Не удалось найти участников по указанным Discord ID.") });
      return;
    }
    const target = members[0];
    if (system === "profile") {
      const rank = getRankFromMemberRoles(target);
      const warnCount = await syncWarningsFromMemberRoles(target);
      await interaction.editReply(embedToComponentPayload(memberEmbed(target.user, rank, warnCount, target), [profileButtons(interaction.user.id, target.id, rank)]));
      return;
    }
    if (action === "history") {
      await interaction.editReply(buildProfileHistory(system, target.id, interaction.user.id, 0));
      return;
    }

    const reason = interaction.fields.getTextInputValue("reason").trim();
    await interaction.editReply({ content: loadingMessage("Пожалуйста, подождите, изменения применяются...") });

    if (system === "rank") {
      const rankOrder = [1, 2, 3, 5, 6, 7, 8, 9, 10];
      const completed = [];
      const failed = [];
      const logLines = [];
      for (const member of members) {
        const oldRank = getRankFromMemberRoles(member);
        const currentIndex = rankOrder.indexOf(oldRank);
        const nextIndex = action === "add" ? currentIndex + 1 : currentIndex - 1;
        if (currentIndex < 0 || nextIndex < 0 || nextIndex >= rankOrder.length) {
          failed.push(`<@${member.id}> — ранг изменить нельзя`);
          continue;
        }
        const newRank = rankOrder[nextIndex];
        try {
          await syncMemberRankRole(member, newRank);
          const syncedNickname = await syncMemberRankNickname(member, newRank);
          await addUserAudit(member.id, "rank", { oldRank, newRank, adminId: interaction.user.id, reason });
          await resetMpBalance(member.id, interaction.user.id, `Смена ранга на ${newRank}`);
          await dmUser(member, { embeds: [new EmbedBuilder().setColor(0x79040c).setTitle("Ваш ранг изменён").setDescription(`**${rankDisplayName(oldRank)} → ${rankDisplayName(newRank)}**`).addFields({ name: "Причина", value: reason }, { name: "Администратор", value: `<@${interaction.user.id}>` })] });
          completed.push(`<@${member.id}> — **${rankDisplayName(oldRank)} → ${rankDisplayName(newRank)}**${syncedNickname ? `, никнейм: **${syncedNickname}**` : ", никнейм не изменён: IC-имя или Static ID не найдены"}`);
          logLines.push(`<@${member.id}> — **${oldRank} → ${newRank}**`);
        } catch (error) {
          failed.push(`<@${member.id}> — ${error.message}`);
        }
      }
      if (logLines.length) await sendLog(interaction.guild, new EmbedBuilder().setColor(0xf2c94c).setTitle(action === "add" ? "Участники повышены" : "Участники понижены").setDescription(logLines.join("\n")).addFields({ name: "Причина", value: reason }, { name: "Администратор", value: `<@${interaction.user.id}>` }));
      await interaction.editReply({
        content: adminActionResult(
          action === "add" ? "Ранг повышен у следующих участников" : "Ранг понижен у следующих участников",
          completed,
          failed
        )
      });
      return;
    }

    if (system === "mp") {
      const amount = Number(String(interaction.fields.getTextInputValue("amount")).replace(",", "."));
      if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount * 2)) {
        await interaction.editReply({ content: errorMessage("Количество баллов должно быть больше нуля и кратно 0,5.") });
        return;
      }
      const completed = [];
      const failed = [];
      for (const member of members) {
        if (isMpPointsExcludedMember(member)) {
          failed.push(`<@${member.id}> — MP-баллы доступны только участникам со 2-го по 7-й ранг`);
          continue;
        }
        const changed = await changeMpBalance(member.id, action === "add" ? amount : -amount, interaction.user.id, reason, member);
        const applied = Math.abs(changed.appliedAmount);
        completed.push(`<@${member.id}> — **${applied} MP**, текущий баланс: **${changed.balance}**`);
        await dmUser(member, { embeds: [new EmbedBuilder().setColor(0x79040c).setTitle(action === "add" ? "Начислены баллы МП" : "Списаны баллы МП").setDescription(`Количество: **${applied}**`).addFields({ name: "Причина", value: reason }, { name: "Текущий баланс", value: String(changed.balance) }, { name: "Администратор", value: `<@${interaction.user.id}>` })] });
      }
      await sendLog(interaction.guild, new EmbedBuilder().setColor(action === "add" ? 0x27ae60 : 0xeb5757).setTitle(action === "add" ? "Начисление баллов МП" : "Списание баллов МП").setDescription([...completed, ...failed].join("\n").slice(0, 4096)).addFields({ name: "Причина", value: reason }, { name: "Администратор", value: `<@${interaction.user.id}>` }));
      await interaction.editReply({
        content: adminActionResult(
          action === "add" ? "Баллы начислены следующим участникам" : "Баллы списаны у следующих участников",
          completed,
          failed
        )
      });
      return;
    }

    if (system === "warn") {
      const completed = [];
      const failed = [];
      const logLines = [];
      for (const member of members) {
        await syncWarningsFromMemberRoles(member);
        const warnings = getWarnings();
        warnings[member.id] ??= { active: [], history: [] };
        if (action === "add") {
          const current = warnings[member.id].active.length;
          if (current >= 3 || (current === 2 && !member.manageable)) {
            failed.push(`<@${member.id}> — варн выдать нельзя`);
            continue;
          }
          const issuedAt = new Date().toISOString();
          warnings[member.id].active.push({ reason, issuedBy: interaction.user.id, issuedAt });
          await saveWarnings(warnings);
          await addUserAudit(member.id, "warn", { action: "add", adminId: interaction.user.id, reason, createdAt: issuedAt });
          const count = warnings[member.id].active.length;
          if (count < 3) await syncWarnRoles(member, count);
          await dmUser(member, { embeds: [new EmbedBuilder().setColor(0x79040c).setTitle("Получен варн").addFields({ name: "Причина", value: reason }, { name: "Всего варнов", value: `${count}/3` }, { name: "Администратор", value: `<@${interaction.user.id}>` })] });
          if (count >= 3) {
            await member.roles.set([], `3/3 варнов. Выдал: ${interaction.user.tag}. Причина: ${reason}`);
          }
          completed.push(`<@${member.id}> — выдан варн **${count}/3**`);
          logLines.push(`<@${member.id}> — **${count}/3**`);
        } else {
          const removed = warnings[member.id].active.pop();
          await saveWarnings(warnings);
          if (removed) await addUserAudit(member.id, "warn", { action: "remove", adminId: interaction.user.id, reason, warnReason: removed.reason });
          await syncWarnRoles(member, warnings[member.id].active.length);
          if (removed) completed.push(`<@${member.id}> — варн снят, осталось **${warnings[member.id].active.length}/3**`);
          else failed.push(`<@${member.id}> — активных варнов нет`);
          if (removed) logLines.push(`<@${member.id}> — осталось **${warnings[member.id].active.length}/3**`);
        }
      }
      if (logLines.length) await sendLog(interaction.guild, new EmbedBuilder().setColor(action === "add" ? 0xeb5757 : 0x27ae60).setTitle(action === "add" ? "Варны выданы" : "Варны сняты").setDescription(logLines.join("\n")).addFields({ name: "Причина", value: reason }, { name: "Администратор", value: `<@${interaction.user.id}>` }));
      await interaction.editReply({
        content: adminActionResult(
          action === "add" ? "Варны выданы следующим участникам" : "Варны сняты у следующих участников",
          completed,
          failed
        )
      });
      return;
    }
  }

  if (interaction.isButton() && interaction.customId === "recruitment:cancel") {
    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => null);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("recruitment:confirm:")) {
    if (!isLeadership(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Эту настройку может менять только руководство фамы."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const [, , section, rawOpen] = interaction.customId.split(":");
    if (!["capt", "rp", "both"].includes(section) || !["0", "1"].includes(rawOpen)) {
      await interaction.update({ content: errorMessage("Некорректные параметры изменения набора."), components: [] });
      return;
    }
    await interaction.deferUpdate();
    const open = rawOpen === "1";
    const botInfo = getBotInfo();
    if (section === "capt" || section === "both") botInfo.captRecruitmentOpen = open;
    if (section === "rp" || section === "both") botInfo.rpRecruitmentOpen = open;
    await saveBotInfo(botInfo, section);
    await flushStorage();
    await refreshApplicationPanel(interaction.guild);

    const sectionText = section === "both" ? "оба состава" : applicationSectionLabel(section);
    await sendLog(
      interaction.guild,
      new EmbedBuilder()
        .setColor(open ? 0x27ae60 : 0xeb5757)
        .setTitle(`Набор ${open ? "открыт" : "закрыт"}`)
        .setDescription(`<@${interaction.user.id}> изменил статус набора в **${sectionText}**.`)
    );
    await interaction.editReply({
      content: successMessage(`Набор в ${sectionText} **${open ? "открыт" : "закрыт"}**!`),
      components: []
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("support:close:")) {
    if (!isSupportReviewer(interaction.member)) {
      await interaction.reply({
        content: "Только ответственная администрация может обрабатывать обращения.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const uid = interaction.customId.slice("support:close:".length);
    const tickets = getSupportTickets();
    const entry = Object.entries(tickets).find(
      ([, ticket]) => ticket.uid === uid && ticket.channelId === interaction.channelId
    );
    if (!entry) {
      await interaction.reply({ content: errorMessage("Обращение не найдено."), flags: MessageFlags.Ephemeral });
      return;
    }
    const [ticketKey, ticket] = entry;
    if (ticket.status === "closed") {
      await interaction.reply({ content: noticeMessage("Обращение уже закрыто."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: `Это обращение ведёт <@${ticket.claimedBy}>.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferUpdate();
    ticket.status = "closed";
    ticket.claimedBy ??= interaction.user.id;
    ticket.closedBy = interaction.user.id;
    ticket.closedAt = new Date().toISOString();
    ticket.updatedAt = ticket.closedAt;
    tickets[ticketKey] = ticket;
    await saveSupportTickets(tickets);

    const user = await interaction.client.users.fetch(ticket.userId).catch(() => null);
    await interaction.message.edit(buildSupportTicketMessagePayload(ticket, user)).catch(() => null);
    await dmUserEmbed(
      user,
      new EmbedBuilder()
        .setColor(0x79040c)
        .setTitle(`Обращение ${ticket.uid} закрыто`)
        .setDescription(`Ваше обращение закрыл <@${interaction.user.id}>.`)
    );
    await sendLog(
      interaction.guild,
      new EmbedBuilder()
        .setColor(0x79040c)
        .setTitle(`Обращение закрыто | ${ticket.uid}`)
        .setDescription(`<@${interaction.user.id}> закрыл обращение <@${ticket.userId}>.\nВетка: ${interaction.channel}`)
    );
    await interaction.channel.send(
      successMessage(`Обращение **${ticket.uid}** закрыл <@${interaction.user.id}>.`)
    );
    if (interaction.channel.isThread()) {
      await interaction.channel.setLocked(true, "Обращение закрыто");
      await interaction.channel.setArchived(true, "Обращение закрыто");
    }
    await interaction.followUp({
      content: successMessage(`Обращение **${ticket.uid}** закрыто!`),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("support:transfer:")) {
    if (!isSupportReviewer(interaction.member)) {
      await interaction.reply({
        content: "Только ответственная администрация может передавать обращения.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const uid = interaction.customId.slice("support:transfer:".length);
    const ticket = Object.values(getSupportTickets()).find(
      (item) => item.uid === uid && item.channelId === interaction.channelId
    );
    if (!ticket || ["approved", "rejected", "closed"].includes(ticket.status)) {
      await interaction.reply({ content: noticeMessage("Обращение не найдено или уже закрыто."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!ticket.claimedBy) {
      await interaction.reply({
        content: "Сначала возьмите обращение сообщением или реакцией.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (ticket.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Передать обращение может только <@${ticket.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.showModal(buildTicketTransferModal("support", uid));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "application:start") {
    const resetApplicationPanel = () => interaction.message.edit(buildApplicationPanel()).catch((error) => {
      console.error("Failed to reset application section selector:", error);
    });
    const section = interaction.values[0];
    const botInfo = getBotInfo();
    const open = section === "capt" ? botInfo.captRecruitmentOpen : botInfo.rpRecruitmentOpen;
    if (!open) {
      await interaction.reply({
        content: noticeMessage(`Набор в ${applicationSectionLabel(section)} сейчас закрыт.`),
        flags: MessageFlags.Ephemeral
      });
      void resetApplicationPanel();
      return;
    }
    const rank = getRankFromMemberRoles(interaction.member);
    if (rank) {
      await interaction.reply({
        content: noticeMessage("Вы уже состоите в фаме, повторно подать заявку на вступление нельзя."),
        flags: MessageFlags.Ephemeral
      });
      void resetApplicationPanel();
      return;
    }

    const applications = getApplications();
    const existingApplication = getLatestApplicationForUser(interaction.user.id, applications);
    if (existingApplication && !["accepted", "rejected", "closed"].includes(existingApplication.status)) {
      await interaction.reply({
        content: noticeMessage("У вас уже есть активная заявка на вступление."),
        flags: MessageFlags.Ephemeral
      });
      void resetApplicationPanel();
      return;
    }

    if (existingApplication?.status === "rejected") {
      const rejectedApplicationClosedAt = Date.parse(existingApplication.closedAt ?? "");
      const retryAt = rejectedApplicationClosedAt + APPLICATION_REJECTION_COOLDOWN_MS;
      if (Number.isFinite(rejectedApplicationClosedAt) && Date.now() < retryAt) {
        await interaction.reply({
          content: noticeMessage(`После отклонения заявки новую можно подать ${discordTimestampFromMs(retryAt)}.`),
          flags: MessageFlags.Ephemeral
        });
        void resetApplicationPanel();
        return;
      }
    }

    await interaction.showModal(buildApplicationModal(section));
    void resetApplicationPanel();
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("application:accept:")) {
    if (!isApplicationReviewer(interaction.member)) {
      await interaction.reply({
        content: "Только ответственная администрация может принимать заявки.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const uid = interaction.customId.slice("application:accept:".length);
    const applicationEntry = findApplicationByUid(uid);
    if (!applicationEntry || applicationEntry[1].channelId !== interaction.channelId) {
      await interaction.reply({
        content: "Заявка не найдена или не относится к этой ветке.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const [applicationKey, application] = applicationEntry;
    if (["accepted", "rejected", "closed"].includes(application.status)) {
      await interaction.reply({ content: noticeMessage("Заявка уже закрыта."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (application.claimedBy && application.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: `Эту заявку ведёт <@${application.claimedBy}>.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferUpdate();
    const applications = getApplications();
    const member = interaction.guild.members.cache.get(application.userId)
      ?? await interaction.guild.members.fetch(application.userId).catch(() => null);
    if (!member) {
      await interaction.followUp({
        content: errorMessage("Кандидат больше не находится на Discord-сервере."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const familyNickname = buildFamilyNickname(1, application.characterInfo);
    let nicknameError = null;
    try {
      await member.roles.add(VERIFIED_MEMBER_ROLE_ID, `Принята заявка в ${applicationSectionLabel(application.requestType)}`);
      const oldRank = getRankFromMemberRoles(member);
      await syncMemberRankRole(member, 1);
      await addUserAudit(member.id, "rank", {
        oldRank,
        newRank: 1,
        adminId: interaction.user.id,
        reason: "Принята заявка на вступление"
      });
      await startMemberAfkGrace(member.id, new Date());
    } catch (error) {
      await interaction.followUp({
        content: errorMessage(`Не удалось выдать роли кандидату: ${error.message}`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (familyNickname) {
      try {
        await member.setNickname(familyNickname, `Принята заявка ${application.uid}`);
      } catch (error) {
        nicknameError = error;
      }
    } else {
      nicknameError = new Error("не удалось сформировать никнейм из данных заявки");
    }

    application.status = "accepted";
    application.claimedBy ??= interaction.user.id;
    application.closedBy = interaction.user.id;
    application.closedAt = new Date().toISOString();
    application.updatedAt = application.closedAt;
    application.decisionReason = null;
    applications[applicationKey] = application;
    const announcementRemoved = await deleteApplicationAnnouncement(interaction.guild, application);
    if (announcementRemoved) {
      application.announcementChannelId = null;
      application.announcementMessageId = null;
    }
    await saveApplications(applications);

    const user = await interaction.client.users.fetch(application.userId).catch(() => null);
    await interaction.message.edit(buildApplicationMessagePayload(application, user)).catch(() => null);
    await dmUserEmbed(
      user,
      buildApplicationDmEmbed(
        application,
        `Заявка ${application.uid} принята`,
        `Ваша заявка принята <@${interaction.user.id}>. Добро пожаловать!`,
        0x27ae60
      )
    );
    const acceptedLog = new EmbedBuilder()
        .setColor(0x27ae60)
        .setTitle(`Заявка принята | ${application.uid}`)
        .setDescription(
          `<@${interaction.user.id}> принял заявку <@${application.userId}>.\nВетка: ${interaction.channel}`
        )
        .addFields({
          name: "Никнейм",
          value: nicknameError
            ? `Не изменён: ${String(nicknameError.message ?? nicknameError).slice(0, 900)}`
            : familyNickname
        });
    await sendLog(interaction.guild, acceptedLog);
    await interaction.channel.send(
      successMessage(`Заявку **${application.uid}** принял <@${interaction.user.id}>.`)
    );
    if (!await closeApplicationThread(interaction.channel, "Заявка принята")) {
      throw new Error("Заявка принята, но ветку не удалось закрыть");
    }
    await interaction.followUp({
      content: nicknameError
        ? noticeMessage(`Заявка **${application.uid}** принята, но изменить никнейм не удалось. Проверьте право бота «Управлять никнеймами» и положение его роли.`)
        : successMessage(`Заявка **${application.uid}** принята! Никнейм изменён на **${familyNickname}**.`),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("application:reject:")) {
    if (!isApplicationReviewer(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может отклонять заявки."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const uid = interaction.customId.slice("application:reject:".length);
    const applicationEntry = findApplicationByUid(uid);
    if (!applicationEntry || applicationEntry[1].channelId !== interaction.channelId) {
      await interaction.reply({
        content: "Заявка не найдена или не относится к этой ветке.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const application = applicationEntry[1];
    if (["accepted", "rejected", "closed"].includes(application.status)) {
      await interaction.reply({ content: noticeMessage("Заявка уже закрыта."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (application.claimedBy && application.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: `Эту заявку ведёт <@${application.claimedBy}>.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.showModal(buildApplicationRejectionModal(uid));
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("application:transfer:")) {
    if (!isApplicationReviewer(interaction.member)) {
      await interaction.reply({
        content: "Только ответственная администрация может передавать заявки.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const uid = interaction.customId.slice("application:transfer:".length);
    const applicationEntry = findApplicationByUid(uid);
    if (!applicationEntry || applicationEntry[1].channelId !== interaction.channelId) {
      await interaction.reply({
        content: "Заявка не найдена или не относится к этой ветке.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const application = applicationEntry[1];
    if (["accepted", "rejected", "closed"].includes(application.status)) {
      await interaction.reply({ content: noticeMessage("Заявка уже закрыта."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!application.claimedBy) {
      await interaction.reply({
        content: "Сначала возьмите заявку сообщением или реакцией.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (application.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Передать заявку может только <@${application.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.showModal(buildTicketTransferModal("application", uid));
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("support:create-submit:")) {
    const nonce = interaction.customId.slice("support:create-submit:".length);
    const requestType = interaction.fields.getStringSelectValues(`request_type:${nonce}`)[0];
    const details = interaction.fields.getTextInputValue(`details:${nonce}`).trim();
    if (!Object.hasOwn(SUPPORT_REQUEST_TYPES, requestType) || details.length < 2) {
      await interaction.reply({
        content: "Не удалось проверить форму. Выберите тип заявки и подробно заполните поле с деталями.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await createGeneralSupportTicket(interaction, requestType, details);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket:transfer-target:")) {
    const [, , scope, uid] = interaction.customId.split(":");
    if (!["application", "support"].includes(scope) || !uid) {
      await interaction.reply({
        content: "Некорректная форма передачи заявки.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const isApplication = scope === "application";
    const canTransfer = isApplication
      ? isApplicationReviewer(interaction.member)
      : isSupportReviewer(interaction.member);
    if (!canTransfer) {
      await interaction.reply({
        content: "Только ответственная администрация может передавать заявки.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const records = isApplication ? getApplications() : getSupportTickets();
    const entry = Object.entries(records).find(
      ([, ticket]) => ticket.uid === uid && ticket.channelId === interaction.channelId
    );
    if (!entry) {
      await interaction.reply({
        content: "Заявка не найдена или не относится к этой ветке.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const [ticketKey, ticket] = entry;
    if (["accepted", "rejected", "closed"].includes(ticket.status)) {
      await interaction.reply({ content: noticeMessage("Заявка уже закрыта."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!ticket.claimedBy) {
      await interaction.reply({
        content: "Сначала возьмите заявку сообщением или реакцией.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (ticket.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: noticeMessage(`Передать заявку может только <@${ticket.claimedBy}>.`),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
      content: loadingMessage("Пожалуйста, подождите, заявка передаётся...")
    });
    const targetInput = interaction.fields.getTextInputValue("target");
    const resolved = await resolveTicketTransferMember(interaction.guild, targetInput);
    if (resolved.error) {
      await interaction.editReply({ content: errorMessage(resolved.error) });
      return;
    }

    const targetMember = resolved.member;
    const validationError = validateTicketTransferMember(targetMember, ticket, scope);
    if (validationError) {
      await interaction.editReply({ content: errorMessage(validationError) });
      return;
    }

    const previousAdminId = ticket.claimedBy;
    ticket.claimedBy = targetMember.id;
    ticket.status = "in_review";
    ticket.updatedAt = new Date().toISOString();
    records[ticketKey] = ticket;
    if (isApplication) await saveApplications(records);
    else await saveSupportTickets(records);

    await keepOnlyTicketParticipants(interaction.channel, [
      ticket.userId,
      targetMember.id,
      interaction.client.user.id
    ]);
    await setApplicantCanWrite(interaction.channel, ticket.userId, true);

    const applicant = await interaction.client.users.fetch(ticket.userId).catch(() => null);
    const entityName = isApplication ? "Заявка" : "Обращение";
    const transferVerb = isApplication ? "передана" : "передано";
    await interaction.channel.send(
      successMessage(`${entityName} **${ticket.uid}** ${transferVerb} <@${previousAdminId}> → <@${targetMember.id}>.`)
    );
    await sendLog(
      interaction.guild,
    new EmbedBuilder()
      .setColor(0x79040c)
        .setTitle(`${isApplication ? "Заявка передана" : "Обращение передано"} | ${ticket.uid}`)
        .setDescription(`<@${interaction.user.id}> передал ${isApplication ? "заявку" : "обращение"}.`)
        .addFields(
          { name: "От кого", value: `<@${previousAdminId}>`, inline: true },
          { name: "Кому", value: `<@${targetMember.id}>`, inline: true },
          { name: "Заявитель", value: `<@${ticket.userId}>`, inline: true }
        )
    );
    await dmUserEmbed(
      applicant,
      new EmbedBuilder()
        .setColor(0x79040c)
        .setTitle(`${entityName} ${ticket.uid} ${transferVerb}`)
        .setDescription(
          `${isApplication ? "Ваша заявка передана администратору" : "Ваше обращение передано администратору"} <@${targetMember.id}>.\n\n${isApplication ? "Открыть заявку" : "Открыть обращение"}: ${interaction.channel}`
        )
    );
    await interaction.editReply({
      content: successMessage(`${entityName} **${ticket.uid}** ${transferVerb} <@${targetMember.id}>!`)
    });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("mpocr_edit:")) {
    if (interaction.user.id !== MP_REPORT_REVIEWER_ID) {
      await interaction.reply({ content: noticeMessage("Изменять список может только назначенный администратор."), flags: MessageFlags.Ephemeral });
      return;
    }

    const [, action, requestId] = interaction.customId.split(":");
    const requests = getMpRequests();
    const request = requests[requestId];
    if (!request || request.status !== "pending") {
      await interaction.reply({ content: noticeMessage("Эта заявка уже обработана или не найдена."), flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
      content: loadingMessage("Пожалуйста, подождите, список участников изменяется...")
    });
    const terms = interaction.fields.getTextInputValue("people")
      .split(/[\n,;]+/)
      .map((term) => term.trim())
      .filter(Boolean);
    const changed = [];
    const notFound = [];

    if (action === "exclude") {
      for (const term of terms) {
        const id = term.match(/\d{17,20}/)?.[0];
        const needle = normalizeSearchText(term).replaceAll(" ", "");
        const before = request.matched.length;
        request.matched = request.matched.filter((entry) => {
          const normalizedName = normalizeSearchText(entry.name).replaceAll(" ", "");
          return id ? entry.userId !== id : !normalizedName.includes(needle);
        });
        if (request.matched.length < before) changed.push(term);
        else notFound.push(term);
      }
    } else {
      const guild = await interaction.client.guilds.fetch(request.guildId).catch(() => null);
      const members = guild ? await listGuildMembers(guild) : [];
      for (const term of terms) {
        const id = term.match(/\d{17,20}/)?.[0];
        const needle = normalizeSearchText(term).replaceAll(" ", "");
        const candidates = members.filter((member) => {
          if (member.user.bot) return false;
          if (id) return member.id === id;
          return normalizeSearchText(member.displayName).replaceAll(" ", "").includes(needle);
        });
        if (candidates.length !== 1) {
          notFound.push(candidates.length ? `${term} (несколько совпадений)` : term);
          continue;
        }
        const member = candidates[0];
        if (isMpPointsExcludedMember(member)) {
          notFound.push(`${term} (8 ранг или выше)`);
          continue;
        }
        if (!request.matched.some((entry) => entry.userId === member.id)) {
          request.matched.push({ name: member.displayName, userId: member.id, addedManually: true });
          changed.push(term);
        }
        request.unmatched = request.unmatched.filter((name) =>
          !normalizeSearchText(member.displayName).replaceAll(" ", "").includes(normalizeSearchText(name).replaceAll(" ", ""))
        );
      }
    }

    requests[requestId] = request;
    await saveMpRequests(requests);
    await editMpReviewMessage(interaction.client, request);
    const requestGuild = await interaction.client.guilds.fetch(request.guildId).catch(() => null);
    if (requestGuild) {
      await sendLog(
        requestGuild,
        new EmbedBuilder()
          .setColor(0x2f80ed)
          .setTitle("Список участников MP изменён")
          .setDescription(`<@${interaction.user.id}> ${action === "exclude" ? "исключил" : "добавил"} участников.`)
          .addFields(
            { name: "Изменено", value: String(changed.length), inline: true },
            { name: "Не найдено", value: String(notFound.length), inline: true }
          )
      );
    }
    await interaction.editReply(successMessage(
      `${action === "exclude" ? "Исключено" : "Добавлено"}: **${changed.length}**.` +
      (notFound.length ? ` Не найдено или неоднозначно: ${notFound.join(", ")}.` : "")
    ));
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("application:reject-reason:")) {
    if (!isApplicationReviewer(interaction.member)) {
      await interaction.reply({
        content: noticeMessage("Только ответственная администрация может отклонять заявки."),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const uid = interaction.customId.split(":")[2];
    const applicationEntry = findApplicationByUid(uid);
    if (!applicationEntry || applicationEntry[1].channelId !== interaction.channelId) {
      await interaction.reply({
        content: "Заявка не найдена или не относится к этой ветке.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const [applicationKey, application] = applicationEntry;
    if (["accepted", "rejected", "closed"].includes(application.status)) {
      await interaction.reply({ content: noticeMessage("Заявка уже закрыта."), flags: MessageFlags.Ephemeral });
      return;
    }
    if (application.claimedBy && application.claimedBy !== interaction.user.id) {
      await interaction.reply({
        content: `Эту заявку ведёт <@${application.claimedBy}>.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
      content: loadingMessage("Пожалуйста, подождите, заявка отклоняется...")
    });
    const reason = interaction.fields.getTextInputValue("reason").trim();
    const applications = getApplications();
    application.status = "rejected";
    application.claimedBy ??= interaction.user.id;
    application.closedBy = interaction.user.id;
    application.closedAt = new Date().toISOString();
    application.updatedAt = application.closedAt;
    application.decisionReason = reason;
    applications[applicationKey] = application;
    const announcementRemoved = await deleteApplicationAnnouncement(interaction.guild, application);
    if (announcementRemoved) {
      application.announcementChannelId = null;
      application.announcementMessageId = null;
    }
    await saveApplications(applications);

    const user = await interaction.client.users.fetch(application.userId).catch(() => null);
    if (application.messageId) {
      const message = await interaction.channel.messages.fetch(application.messageId).catch(() => null);
      if (message) {
        await message.edit(buildApplicationMessagePayload(application, user)).catch(() => null);
      }
    }
    await dmUserEmbed(
        user,
        buildApplicationDmEmbed(
          application,
          `Заявка ${application.uid} отклонена`,
          "Заявку на вступление можно будет подать повторно через 10 дней.",
          0xeb5757
        )
      );
    await sendLog(
      interaction.guild,
      new EmbedBuilder()
        .setColor(0xeb5757)
        .setTitle(`Заявка отклонена | ${application.uid}`)
        .setDescription(
          `<@${interaction.user.id}> отклонил заявку <@${application.userId}>.\nПричина: **${reason}**\nВетка: ${interaction.channel}`
        )
    );
    await interaction.channel.send(
      `Заявку **${application.uid}** отклонил <@${interaction.user.id}>.`
    );
    if (!await closeApplicationThread(interaction.channel, "Заявка отклонена")) {
      throw new Error("Заявка отклонена, но ветку не удалось закрыть");
    }
    await interaction.editReply({ content: successMessage(`Заявка **${application.uid}** отклонена!`) });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("family_application:")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const section = interaction.customId.split(":")[1];
    if (!["capt", "rp"].includes(section)) {
      await interaction.editReply({ content: errorMessage("Не удалось определить выбранный состав.") });
      return;
    }
    const botInfo = getBotInfo();
    const recruitmentOpen = section === "capt"
      ? botInfo.captRecruitmentOpen
      : botInfo.rpRecruitmentOpen;
    if (!recruitmentOpen) {
      await interaction.editReply({
        content: noticeMessage(`Набор в ${applicationSectionLabel(section)} уже закрыт.`)
      });
      return;
    }

    const rank = await getRankFromUser(interaction.guild, interaction.user.id);
    if (rank) {
      await interaction.editReply({
        content: noticeMessage("Вы уже состоите в фаме, повторно подать заявку на вступление нельзя.")
      });
      return;
    }

    const applications = getApplications();
    const existingApplication = getLatestApplicationForUser(interaction.user.id, applications);
    if (existingApplication && !["accepted", "rejected", "closed"].includes(existingApplication.status)) {
      await interaction.editReply({ content: noticeMessage("У вас уже есть активная заявка на вступление.") });
      return;
    }
    if (existingApplication?.status === "rejected") {
      const rejectedAt = Date.parse(existingApplication.closedAt ?? "");
      const retryAt = rejectedAt + APPLICATION_REJECTION_COOLDOWN_MS;
      if (Number.isFinite(rejectedAt) && Date.now() < retryAt) {
        await interaction.editReply({
          content: noticeMessage(`После отклонения заявки новую можно подать ${discordTimestampFromMs(retryAt)}.`)
        });
        return;
      }
    }

    const characterInfo = interaction.fields.getTextInputValue("character");
    const characterParts = characterInfo.split("/").map((part) => part.trim());
    const validCharacterInfo = characterParts.length === 3 &&
      characterParts.every(Boolean) &&
      /^\d+$/.test(characterParts[1]) &&
      /^\d+$/.test(characterParts[2]);
    if (!validCharacterInfo) {
      await interaction.editReply({
        content: errorMessage("Укажите данные в формате: IC имя / уровень персонажа / Static ID.")
      });
      return;
    }
    const captRole = section === "capt"
      ? interaction.fields.getStringSelectValues("capt_role")[0]
      : null;
    if (section === "capt" && !["Collers", "Main"].includes(captRole)) {
      await interaction.editReply({ content: errorMessage("Выберите, кем хотите быть: Collers или Main.") });
      return;
    }
    const values = {
      characterInfo,
      oocAge: interaction.fields.getTextInputValue("ooc_age"),
      reason: interaction.fields.getTextInputValue("reason"),
      captRole
    };

    await interaction.editReply({
      content: loadingMessage("Пожалуйста, подождите, ваша заявка создаётся...")
    });

    const uid = createTicketUid("A", applications, getSupportTickets());
    const applicationKey = `${interaction.user.id}-${Date.now()}`;
    const channel = await createApplicationChannel(interaction, uid);
    const application = {
      userId: interaction.user.id,
      uid,
      channelId: channel.id,
      messageId: null,
      status: "new",
      requestType: section,
      characterInfo: values.characterInfo,
      oocAge: values.oocAge,
      reason: values.reason,
      captRole: values.captRole,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    applications[applicationKey] = application;
    await saveApplications(applications);

    const message = await channel.send(buildApplicationMessagePayload(application, interaction.user));
    applications[applicationKey].messageId = message.id;
    await saveApplications(applications);

    await addTicketThreadMembers(channel, [interaction.user.id]);
    await interaction.editReply({ content: successMessage(`Заявка создана! ${channel}`) });
    await dmUserEmbed(
      interaction.user,
      buildApplicationDmEmbed(
        application,
        "Заявка создана",
        `Ваша заявка в **${config.familyName}** создана и направлена администрации. Ожидайте начала рассмотрения.`,
        0x56ccf2,
        [
          { name: "Статус", value: applicationStatusLabel(application.status), inline: true }
        ]
      )
    );
    await channel.setInvitable(false, "Все участники заявки добавлены").catch((error) => {
      console.error(`Failed to disable invitations for ticket thread ${channel.id}:`, error);
    });

    const applicationsChannel = config.applicationsChannelId
      ? await interaction.guild.channels.fetch(config.applicationsChannelId).catch(() => null)
      : null;
    if (applicationsChannel?.isTextBased() && applicationsChannel.id !== channel.id) {
      const announcement = await applicationsChannel.send(
        `Новая заявка в **${applicationSectionLabel(application.requestType)}** **${uid}**: ${channel}`
      );
      const latestApplications = getApplications();
      if (latestApplications[applicationKey]?.channelId === channel.id) {
        latestApplications[applicationKey].announcementChannelId = applicationsChannel.id;
        latestApplications[applicationKey].announcementMessageId = announcement.id;
        await saveApplications(latestApplications);
      }
    }

    await sendLog(
      interaction.guild,
      new EmbedBuilder()
        .setColor(0x56ccf2)
        .setTitle(`Заявка на вступление | ${uid}`)
        .setDescription(`<@${interaction.user.id}> создал заявку в ${config.familyName}.`)
        .addFields(
          { name: "UID", value: uid, inline: true },
          { name: "Состав", value: applicationSectionLabel(application.requestType), inline: true },
          { name: "IC имя / уровень / Static ID", value: String(application.characterInfo).slice(0, 1024) },
          ...(application.requestType === "capt"
            ? [{ name: "Кем хочет быть", value: String(application.captRole).slice(0, 1024), inline: true }]
            : []),
          { name: "OOC возраст", value: String(application.oocAge).slice(0, 1024), inline: true }
        )
    );

  }

}

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch(async (error) => {
    console.error("Interaction processing failed:", error);
    if (!interaction.isRepliable()) return;

    const content = errorMessage("Не удалось выполнить действие из-за внутренней ошибки. Попробуйте ещё раз.");
    if (interaction.deferred) {
      if (interaction.message?.flags?.has(MessageFlags.IsComponentsV2)) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
        return;
      }
      await interaction.editReply({ content }).catch(() => null);
      return;
    }
    if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
  });
});

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  throw new Error("Сначала укажите DISCORD_TOKEN в .env.");
}

async function startBot() {
  await initStorage();
  await client.login(DISCORD_TOKEN);
}

async function shutdown(signal) {
  console.log(`Received ${signal}, closing MySQL storage.`);
  await closeStorage().catch((error) => console.error("Failed to close MySQL storage:", error));
  client.destroy();
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

startBot().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exitCode = 1;
});

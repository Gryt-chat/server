// @ts-check

import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'dist-selfhosted/', '*.js'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Our own values get real types; a file parsing outside input says so at the top (GRYT-1792).
      '@typescript-eslint/no-restricted-types': ['error', { types: { unknown: "Type it. If it's outside input being checked, disable at the top of the file with the reason." } }],
      'no-restricted-syntax': ['error', {
        selector: "TSAsExpression > TSAsExpression.expression[typeAnnotation.type='TSUnknownKeyword']",
        message: "Don't cast through unknown. Fix the types, or disable this line with the reason.",
      }],
      'no-nested-ternary': 'error',
      eqeqeq: ['error', 'smart'],
      'no-else-return': 'error',
      'prefer-const': 'error',
      'no-param-reassign': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-namespace': 'warn',
    },
  },
  // The ad-hoc scripts. Nothing here declared Node globals, so every `process`
  // and `require` in scripts/ was a no-undef error — 47 of them, which is why
  // CI lints src/ rather than the whole repo (GRYT-268). None were real
  // defects; the config simply never described these files.
  {
    files: ['scripts/**'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // scripts/upload-route-test.cjs is CommonJS by extension and by intent.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  // Existing debt, listed per rule rather than marked in each file. The goal is to empty these (GRYT-1792).
  // unknown: socket payloads arrive unchecked and are validated there.
  {
    files: [
      'src/plugins/guard.ts',
      'src/plugins/messaging.ts',
      'src/routes/emojiBttvImport.ts',
      'src/routes/uploads.ts',
      'src/routes/webhookOpenapi.ts',
      'src/routes/webhookSchemas.ts',
      'src/services/webhookMedia.ts',
      'src/socket/handlers/admin.ts',
      'src/socket/handlers/calls.ts',
      'src/socket/handlers/chat.ts',
      'src/socket/handlers/contactPrefs.ts',
      'src/socket/handlers/friends.ts',
      'src/socket/handlers/join.ts',
      'src/socket/handlers/mls.ts',
      'src/socket/handlers/mlsPersonKey.ts',
      'src/socket/handlers/plugins.ts',
      'src/socket/handlers/push.ts',
      'src/socket/handlers/reports.ts',
      'src/socket/index.ts',
      'src/socket/utils/server.ts',
      'src/utils/fileUrl.ts',
    ],
    rules: { '@typescript-eslint/no-restricted-types': 'off' },
  },
  // unknown: requests and responses arrive unchecked.
  {
    files: [
      'src/routes/discordImport.ts',
      'src/routes/emojiStaging.ts',
      'src/routes/emojis.ts',
      'src/routes/linkPreview.ts',
      'src/routes/oembed.ts',
      'src/services/workerCapabilities.ts',
      'src/utils/httpErrors.ts',
      'src/utils/safePreviewFetch.ts',
      'src/versionCheck.ts',
    ],
    rules: { '@typescript-eslint/no-restricted-types': 'off' },
  },
  // unknown: stored and parsed data arrives unchecked and is validated there.
  {
    files: [
      'src/import/discord/exportFolder.ts',
      'src/import/discord/importer.ts',
      'src/plugins/host.ts',
      'src/services/storeUploadedFile.ts',
      'src/utils/memberCard.ts',
    ],
    rules: { '@typescript-eslint/no-restricted-types': 'off' },
  },
  // unknown: caught errors are unknown until checked.
  {
    files: [
      'src/admin/setOwner.ts',
      'src/moderation/deleteMessage.ts',
      'src/socket/handlers/members.ts',
    ],
    rules: { '@typescript-eslint/no-restricted-types': 'off' },
  },
  // unknown: tests build loose payloads on purpose.
  {
    files: [
      'src/plugins/host.test.ts',
      'src/plugins/manifest.test.ts',
      'src/plugins/messaging.test.ts',
      'src/plugins/roundTrip.test.ts',
      'src/routes/bannerUpload.test.ts',
      'src/routes/discordImport.test.ts',
      'src/routes/fileRead.test.ts',
      'src/routes/groupIconUpload.test.ts',
      'src/routes/routeJsonLimits.test.ts',
      'src/routes/uploadAuthOrder.test.ts',
      'src/routes/uploadQuarantine.test.ts',
      'src/routes/webhookAvatar.test.ts',
      'src/routes/webhookBodyErrors.test.ts',
      'src/routes/webhookCards.test.ts',
      'src/routes/webhookSchemas.test.ts',
      'src/routes/webhookUrl.test.ts',
      'src/services/mentionSyntax.test.ts',
      'src/services/push.test.ts',
      'src/services/pushPreview.test.ts',
      'src/settings/externalEmojis.test.ts',
      'src/socket/handlers/automatedChannels.test.ts',
      'src/socket/handlers/blocks.test.ts',
      'src/socket/handlers/callRinging.test.ts',
      'src/socket/handlers/channelNotificationDefaults.test.ts',
      'src/socket/handlers/channelPermissionRules.test.ts',
      'src/socket/handlers/channelReactions.test.ts',
      'src/socket/handlers/channelSidebarRow.test.ts',
      'src/socket/handlers/channelVisibilityLeaks.test.ts',
      'src/socket/handlers/chatErrorNonce.test.ts',
      'src/socket/handlers/chatSearch.test.ts',
      'src/socket/handlers/clientRecordLeaks.test.ts',
      'src/socket/handlers/contactPrefs.test.ts',
      'src/socket/handlers/conversationRefusalEvent.test.ts',
      'src/socket/handlers/directMessages.test.ts',
      'src/socket/handlers/dmKeys.test.ts',
      'src/socket/handlers/folderPermissions.test.ts',
      'src/socket/handlers/forgetIdentityLeavesVoice.test.ts',
      'src/socket/handlers/forumTags.test.ts',
      'src/socket/handlers/forumTopics.test.ts',
      'src/socket/handlers/friends.test.ts',
      'src/socket/handlers/identityReplace.test.ts',
      'src/socket/handlers/leaveServer.test.ts',
      'src/socket/handlers/liveMessageRecipients.test.ts',
      'src/socket/handlers/massMentions.test.ts',
      'src/socket/handlers/memberCard.test.ts',
      'src/socket/handlers/memberInvites.test.ts',
      'src/socket/handlers/mls.test.ts',
      'src/socket/handlers/mlsPersonKey.test.ts',
      'src/socket/handlers/mlsReports.test.ts',
      'src/socket/handlers/ownerRoleColour.test.ts',
      'src/socket/handlers/permissionGates.test.ts',
      'src/socket/handlers/pluginMessages.test.ts',
      'src/socket/handlers/polls.test.ts',
      'src/socket/handlers/presenceRateLimit.test.ts',
      'src/socket/handlers/presenceRichActivity.test.ts',
      'src/socket/handlers/pushAudience.test.ts',
      'src/socket/handlers/scopeTemplates.test.ts',
      'src/socket/handlers/sendAcrossRestart.test.ts',
      'src/socket/handlers/sessions.test.ts',
      'src/socket/handlers/sidebarFolders.test.ts',
      'src/socket/handlers/spamFilter.test.ts',
      'src/socket/handlers/textMute.test.ts',
      'src/socket/handlers/threadStatus.test.ts',
      'src/socket/handlers/threadSummaryShape.test.ts',
      'src/socket/handlers/tokenRefresh.test.ts',
      'src/socket/handlers/typing.test.ts',
      'src/socket/handlers/userReports.test.ts',
      'src/socket/handlers/voiceChannelSwitch.test.ts',
      'src/socket/handlers/voiceJoinAnnounce.test.ts',
      'src/socket/handlers/voiceRoomAccess.test.ts',
      'src/socket/handlers/voiceSpeakCapability.test.ts',
      'src/socket/utils/callParticipants.test.ts',
      'src/socket/utils/channelPermissionsPayload.test.ts',
      'src/socket/utils/clientNotices.test.ts',
      'src/socket/utils/emitToMember.test.ts',
      'src/socket/utils/publicClientList.test.ts',
      'src/socket/utils/serverDetailsBootstrap.test.ts',
      'src/socket/utils/serverInfo.test.ts',
      'src/socket/utils/voiceCapabilities.test.ts',
      'src/socket/voiceRecovery.test.ts',
      'src/utils/linkResolvers.test.ts',
      'src/utils/memberCard.test.ts',
      'src/utils/richActivity.test.ts',
    ],
    rules: { '@typescript-eslint/no-restricted-types': 'off' },
  },
  // unknown: type guards and normalisers that check a value from outside before using it.
  {
    files: [
      'src/constants/permissions.ts',
      'src/import/discord/dce.ts',
      'src/moderation/spamFilter.ts',
      'src/plugins/manifest.ts',
      'src/polls/poll.ts',
      'src/routes/uploadStorage.ts',
      'src/services/mlsWire.ts',
      'src/utils/activityText.ts',
      'src/utils/linkResolvers.ts',
      'src/utils/profanityFilter.ts',
      'src/utils/publicOnlyAgent.ts',
      'src/utils/richActivity.ts',
      'src/utils/wornString.ts',
    ],
    rules: { '@typescript-eslint/no-restricted-types': 'off' },
  },
  // Tests may cast through unknown to hand a fake where the real type is wide.
  {
    files: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // undici's Response and the DOM's disagree on the body's chunk type. The comment at the cast says why.
  {
    files: ['src/utils/safePreviewFetch.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // Tests may assert non-null: a wrong guess fails the test, which is the point.
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  // Reassigned parameters from before the rule.
  {
    files: [
      'src/socket/handlers/mls.ts',
      'src/socket/handlers/mlsPersonKey.ts',
      'src/socket/handlers/push.ts',
    ],
    rules: { 'no-param-reassign': 'off' },
  },
  // any from before the rule.
  {
    files: [
      'src/socket/utils/clientNotices.test.ts',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  // Review-required paths are not edited from here. Their debt is exempted until a reviewed PR fixes it.
  {
    files: ['src/auth/**', 'src/middleware/**', 'src/db/**', 'src/storage/**'],
    rules: {
      '@typescript-eslint/no-restricted-types': 'off',
      'no-restricted-syntax': 'off',
      'no-nested-ternary': 'off',
      eqeqeq: 'off',
      'no-else-return': 'off',
      'prefer-const': 'off',
      'no-param-reassign': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);

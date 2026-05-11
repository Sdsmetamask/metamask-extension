import type {
  AnalyticsEventProperties,
  AnalyticsPlatformAdapter as CoreAnalyticsPlatformAdapter,
  AnalyticsUserTraits,
} from '@metamask/analytics-controller';
import {
  METAMETRICS_ANONYMOUS_ID,
  MetaMetricsEventName,
} from '../../../../shared/constants/metametrics';
import {
  AnonymousTransactionMetaMetricsEvent,
  TransactionMetaMetricsEvent,
} from '../../../../shared/constants/transaction';
import {
  segment as extensionSegmentSingleton,
  type SegmentClient,
} from '../../lib/segment';

export const ANONYMOUS_EVENT_PROPERTY = 'anonymous' as const;

const anonymousEventNameOverrides = {
  [TransactionMetaMetricsEvent.added]:
    AnonymousTransactionMetaMetricsEvent.added,
  [TransactionMetaMetricsEvent.approved]:
    AnonymousTransactionMetaMetricsEvent.approved,
  [TransactionMetaMetricsEvent.finalized]:
    AnonymousTransactionMetaMetricsEvent.finalized,
  [TransactionMetaMetricsEvent.rejected]:
    AnonymousTransactionMetaMetricsEvent.rejected,
  [TransactionMetaMetricsEvent.submitted]:
    AnonymousTransactionMetaMetricsEvent.submitted,
  [MetaMetricsEventName.SignatureRequested]:
    MetaMetricsEventName.SignatureRequestedAnon,
  [MetaMetricsEventName.SignatureApproved]:
    MetaMetricsEventName.SignatureApprovedAnon,
  [MetaMetricsEventName.SignatureRejected]:
    MetaMetricsEventName.SignatureRejectedAnon,
} as const;

/**
 * Forward-compat shim for {@link AnalyticsInvocationOptions}, added to the
 * core `AnalyticsController` in MetaMask/core#8701 (currently a draft PR).
 * Replace this local type with the package import once that PR lands.
 */
export type AnalyticsInvocationOptions = {
  context?: Record<string, unknown>;
  callback?: (err?: unknown, ctx?: unknown) => void;
  messageId?: string;
  timestamp?: string | Date;
};

/**
 * Forward-compat extension to {@link CoreAnalyticsPlatformAdapter}: the
 * core platform adapter gains `skipUUIDv4Check` (PR MetaMask/core#8543) and
 * receives invocation options (PR MetaMask/core#8701). Once those land, this
 * type can be removed and the import switched back to the package directly.
 */
export type AnalyticsPlatformAdapter = Omit<
  CoreAnalyticsPlatformAdapter,
  'track' | 'identify' | 'view'
> & {
  skipUUIDv4Check?: boolean;
  track(
    eventName: string,
    properties?: AnalyticsEventProperties,
    options?: AnalyticsInvocationOptions,
  ): void;
  identify(
    userId: string,
    traits?: AnalyticsUserTraits,
    options?: AnalyticsInvocationOptions,
  ): void;
  view(
    name: string,
    properties?: AnalyticsEventProperties,
    options?: AnalyticsInvocationOptions,
  ): void;
};

function getSegmentClient(): SegmentClient {
  return extensionSegmentSingleton;
}

type BasePayload = {
  context?: AnalyticsInvocationOptions['context'];
  messageId?: string;
  timestamp?: AnalyticsInvocationOptions['timestamp'];
} & ({ userId: string } | { anonymousId: string });

function buildBasePayload(
  identity: { userId: string } | { anonymousId: string },
  options?: AnalyticsInvocationOptions,
): BasePayload {
  return {
    ...identity,
    ...(options?.context ? { context: options.context } : {}),
    ...(options?.messageId ? { messageId: options.messageId } : {}),
    ...(options?.timestamp ? { timestamp: options.timestamp } : {}),
  };
}

function getAnonymousEventName(eventName: string): string {
  return (
    anonymousEventNameOverrides[
      eventName as keyof typeof anonymousEventNameOverrides
    ] ?? eventName
  );
}

/**
 * Platform adapter for the AnalyticsController.
 *
 * - Build full Segment payloads from
 * `(eventName, properties, AnalyticsInvocationOptions)`. Track payloads marked
 * with `properties.anonymous` are downgraded to the shared anonymous ID before
 * being sent to Segment.
 *
 * Sets `skipUUIDv4Check: true`: extension `analyticsId` values are
 * non-UUIDv4 hex strings (PR MetaMask/core#8543).
 */
export function createPlatformAdapter(): AnalyticsPlatformAdapter {
  let cachedAnalyticsId: string;
  const client = getSegmentClient();

  return {
    skipUUIDv4Check: true,

    track(
      eventName: string,
      properties?: AnalyticsEventProperties,
      options?: AnalyticsInvocationOptions,
    ): void {
      const isAnonymousEvent =
        properties?.[ANONYMOUS_EVENT_PROPERTY] === true;
      let payloadProperties = properties;
      if (isAnonymousEvent) {
        payloadProperties = { ...properties };
        delete payloadProperties[ANONYMOUS_EVENT_PROPERTY];
      }

      const payload = {
        ...buildBasePayload(
          isAnonymousEvent
            ? { anonymousId: METAMETRICS_ANONYMOUS_ID }
            : { userId: cachedAnalyticsId },
          options,
        ),
        event: isAnonymousEvent ? getAnonymousEventName(eventName) : eventName,
        ...(payloadProperties ? { properties: payloadProperties } : {}),
      };
      client.track(payload, options?.callback);
    },

    identify(
      userId: string,
      traits?: AnalyticsUserTraits,
      options?: AnalyticsInvocationOptions,
    ): void {
      const payload = {
        ...buildBasePayload({ userId }, options),
        ...(traits ? { traits } : {}),
      };
      client.identify(payload, options?.callback);
    },

    view(
      name: string,
      properties?: AnalyticsEventProperties,
      options?: AnalyticsInvocationOptions,
    ): void {
      const payload = {
        ...buildBasePayload({ userId: cachedAnalyticsId }, options),
        name,
        ...(properties ? { properties } : {}),
      };
      client.page(payload, options?.callback);
    },

    onSetupCompleted(analyticsId: string): void {
      cachedAnalyticsId = analyticsId;
    },
  };
}

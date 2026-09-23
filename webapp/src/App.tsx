// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppLayout from '@cloudscape-design/components/app-layout';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Flashbar, { type FlashbarProps } from '@cloudscape-design/components/flashbar';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import Pagination from '@cloudscape-design/components/pagination';
import Select, { type SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import Toggle from '@cloudscape-design/components/toggle';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import { api } from './api';
import {
  CATEGORY_SOURCE,
  SERVICE_CATEGORIES,
  UNCLASSIFIED_CATEGORY,
  categorizeService,
  type ServiceCategory,
} from './categories';
import type {
  CatalogResponse,
  CategorizedService,
  CheckResult,
  CheckServiceChange,
  CollectionStatus,
  Job,
  JobKind,
  RefreshReport,
  RefreshServiceResult,
  RefreshServiceStatus,
} from './types';

type ScopeFilter = 'all' | 'tracked' | 'untracked' | 'unmapped';

const PAGE_SIZE = 20;

const scopeOptions: SelectProps.Option[] = [
  { label: 'All statuses', value: 'all' },
  { label: 'Tracked', value: 'tracked' },
  { label: 'Untracked', value: 'untracked' },
  { label: 'Needs collection', value: 'unmapped' },
];

function initialCategory(): string {
  return new URLSearchParams(window.location.search).get('category') || 'all';
}

function formatAge(value: string): string {
  if (!value) return 'Never';
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 1) return 'Just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) return `${elapsedHours}h ago`;
  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function collectionStatus(status: CollectionStatus) {
  if (status === 'mapped') return <StatusIndicator type="success">Mapped</StatusIndicator>;
  if (status === 'missing') return <StatusIndicator type="error">Deleted</StatusIndicator>;
  return <StatusIndicator type="warning">Unmapped</StatusIndicator>;
}

function trackingStatus(tracked: boolean) {
  return tracked
    ? <StatusIndicator type="success">Tracked</StatusIndicator>
    : <StatusIndicator type="stopped">Untracked</StatusIndicator>;
}

function isCheckServiceChange(value: unknown): value is CheckServiceChange {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CheckServiceChange>;
  return typeof candidate.service === 'string'
    && Array.isArray(candidate.ops_added)
    && candidate.ops_added.every((operation) => typeof operation === 'string')
    && Array.isArray(candidate.ops_removed)
    && candidate.ops_removed.every((operation) => typeof operation === 'string');
}

function isCheckResult(value: Record<string, unknown> | null): value is CheckResult {
  if (!value) return false;
  return typeof value.initialized === 'boolean'
    && typeof value.source_ref === 'string'
    && Array.isArray(value.changed_tracked)
    && value.changed_tracked.every(isCheckServiceChange)
    && typeof value.untracked_changed === 'number';
}

function isRefreshReport(value: Record<string, unknown> | null): value is RefreshReport {
  if (!value) return false;
  return typeof value.command === 'string'
    && typeof value.dry_run === 'boolean'
    && Array.isArray(value.targets)
    && typeof value.services === 'object'
    && value.services !== null;
}

const REFRESH_SUCCESS_STATUSES = new Set<RefreshServiceStatus>(['updated', 'created', 'skipped-unchanged', 'dry-run']);

function refreshServiceStatusIndicator(status: RefreshServiceStatus | null) {
  switch (status) {
    case 'updated': return <StatusIndicator type="success">Updated</StatusIndicator>;
    case 'created': return <StatusIndicator type="success">Created</StatusIndicator>;
    case 'skipped-unchanged': return <StatusIndicator type="info">Unchanged</StatusIndicator>;
    case 'dry-run': return <StatusIndicator type="pending">Would update</StatusIndicator>;
    case 'failed-route': return <StatusIndicator type="error">Not found in model source</StatusIndicator>;
    case 'failed-convert': return <StatusIndicator type="error">Conversion failed</StatusIndicator>;
    case 'failed-collection': return <StatusIndicator type="error">Collection build failed</StatusIndicator>;
    case 'failed-push': return <StatusIndicator type="error">Publish failed</StatusIndicator>;
    case 'failed-unmapped': return <StatusIndicator type="error">Needs creation</StatusIndicator>;
    default: return <StatusIndicator type="pending">Pending</StatusIndicator>;
  }
}

interface CategoryNavigationProps {
  categories: ServiceCategory[];
  services: CategorizedService[];
  activeCategoryId: string;
  selectedIds: Set<string>;
  onCategoryChange: (categoryId: string) => void;
  onSelectionChange: (serviceId: string, selected: boolean) => void;
}

function CategoryNavigation({
  categories,
  services,
  activeCategoryId,
  selectedIds,
  onCategoryChange,
  onSelectionChange,
}: CategoryNavigationProps) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(activeCategoryId === 'all' ? [] : [activeCategoryId]),
  );

  useEffect(() => {
    if (activeCategoryId !== 'all') {
      setExpanded((current) => new Set(current).add(activeCategoryId));
    }
  }, [activeCategoryId]);

  const servicesByCategory = useMemo(() => {
    const result = new Map<string, CategorizedService[]>();
    for (const category of categories) {
      result.set(
        category.id,
        services
          .filter((service) => service.categoryIds.includes(category.id))
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
    }
    return result;
  }, [categories, services]);

  function toggleCategory(categoryId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }

  return (
    <nav className="category-navigation" aria-label="AWS service categories">
      <div className="category-navigation__heading">
        <Box variant="h2">Service categories</Box>
        <Link external href={CATEGORY_SOURCE}>AWS source</Link>
      </div>
      <button
        type="button"
        className={`category-navigation__all ${activeCategoryId === 'all' ? 'is-active' : ''}`}
        onClick={() => onCategoryChange('all')}
      >
        <span>All Services</span>
        <Badge color="grey">{services.length}</Badge>
      </button>
      <div className="category-navigation__list">
        {categories.map((category) => {
          const categoryServices = servicesByCategory.get(category.id) ?? [];
          const isExpanded = expanded.has(category.id);
          const isActive = activeCategoryId === category.id;
          const trackedCount = categoryServices.filter((service) => service.tracked).length;
          const unmappedCount = categoryServices.filter(
            (service) => service.tracked && service.collection_status !== 'mapped',
          ).length;
          return (
            <div className="category-navigation__group" key={category.id}>
              <div className={`category-navigation__row ${isActive ? 'is-active' : ''}`}>
                <button
                  type="button"
                  className={`category-navigation__toggle ${isExpanded ? 'is-expanded' : ''}`}
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${category.label}`}
                  aria-expanded={isExpanded}
                  onClick={() => toggleCategory(category.id)}
                />
                <button
                  type="button"
                  className="category-navigation__category"
                  onClick={() => {
                    onCategoryChange(category.id);
                    setExpanded((current) => new Set(current).add(category.id));
                  }}
                >
                  <span>{category.label}</span>
                  <span className="category-navigation__counts">
                    {categoryServices.length}
                    {trackedCount > 0 && <span title={`${trackedCount} tracked`}> / {trackedCount}</span>}
                    {unmappedCount > 0 && (
                      <span
                        className="category-navigation__attention"
                        title={`${unmappedCount} need creation`}
                      >
                        {' '}/ {unmappedCount}
                      </span>
                    )}
                  </span>
                </button>
              </div>
              {isExpanded && (
                <div className="category-navigation__services">
                  {categoryServices.map((service) => (
                    <Checkbox
                      key={service.id}
                      checked={selectedIds.has(service.id)}
                      onChange={({ detail }) => onSelectionChange(service.id, detail.checked)}
                    >
                      <span title={service.id}>{service.name}</span>
                    </Checkbox>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

interface ModelUpdatePanelProps {
  job: Job | null;
  services: CategorizedService[];
}

function ModelUpdatePanel({ job, services }: ModelUpdatePanelProps) {
  const serviceNames = useMemo(
    () => new Map(services.map((service) => [service.id, service.name])),
    [services],
  );
  const result = job && isCheckResult(job.result) ? job.result : null;

  if (!job) {
    return (
      <section className="model-update-panel is-idle" aria-labelledby="model-update-title">
        <div className="model-update-panel__heading">
          <div>
            <Box id="model-update-title" variant="h2">AWS model updates</Box>
            <Box color="text-body-secondary">No update check has run in this deployment.</Box>
          </div>
          <StatusIndicator type="pending">Not checked</StatusIndicator>
        </div>
      </section>
    );
  }

  if (job.status === 'running') {
    return (
      <section
        className="model-update-panel is-running"
        aria-labelledby="model-update-title"
        aria-live="polite"
      >
        <div className="model-update-panel__heading">
          <div>
            <Box id="model-update-title" variant="h2">Checking AWS model updates</Box>
            <Box color="text-body-secondary">
              Started at {new Date(job.started_at).toLocaleTimeString()}. Typical duration is 2-3 minutes.
            </Box>
          </div>
          <StatusIndicator type="in-progress">Running</StatusIndicator>
        </div>
        <div className="model-update-activity" aria-hidden="true"><span /></div>
        <div className="model-update-panel__running-copy">
          Loading the AWS model source and comparing tracked service operations.
        </div>
      </section>
    );
  }

  if (job.status === 'failed') {
    return (
      <section className="model-update-panel is-error" aria-labelledby="model-update-title">
        <div className="model-update-panel__heading">
          <div>
            <Box id="model-update-title" variant="h2">AWS model update check failed</Box>
            <Box color="text-body-secondary">
              Finished in {formatDuration(job.started_at, job.finished_at)}.
            </Box>
          </div>
          <StatusIndicator type="error">Failed</StatusIndicator>
        </div>
        {job.output && (
          <ExpandableSection headerText="Failure details" defaultExpanded>
            <pre className="job-output">{job.output}</pre>
          </ExpandableSection>
        )}
      </section>
    );
  }

  if (!result) {
    return (
      <section className="model-update-panel is-success" aria-labelledby="model-update-title">
        <div className="model-update-panel__heading">
          <div>
            <Box id="model-update-title" variant="h2">AWS model update check complete</Box>
            <Box color="text-body-secondary">
              Finished in {formatDuration(job.started_at, job.finished_at)}. Detailed results were not retained for this earlier run.
            </Box>
          </div>
          <StatusIndicator type="success">Complete</StatusIndicator>
        </div>
      </section>
    );
  }

  if (!result.initialized) {
    return (
      <section className="model-update-panel is-warning" aria-labelledby="model-update-title">
        <div className="model-update-panel__heading">
          <div>
            <Box id="model-update-title" variant="h2">Synchronization baseline required</Box>
            <Box color="text-body-secondary">{result.message || 'No synchronization state exists.'}</Box>
          </div>
          <StatusIndicator type="warning">Action required</StatusIndicator>
        </div>
      </section>
    );
  }

  const sourceCommits = result.source_commits_pending ?? 0;
  const changedTracked = result.changed_tracked;
  const untrackedChanged = result.untracked_changed;
  const localSyncPending = result.local_sync_pending ?? 0;

  return (
    <section className="model-update-panel is-success" aria-labelledby="model-update-title">
      <div className="model-update-panel__heading">
        <div>
          <Box id="model-update-title" variant="h2">AWS model update check complete</Box>
          <Box color="text-body-secondary">
            Finished {formatAge(job.finished_at || job.started_at)} in {formatDuration(job.started_at, job.finished_at)}.
          </Box>
        </div>
        <StatusIndicator type="success">Complete</StatusIndicator>
      </div>

      <div className="model-update-summary">
        <div className="model-update-stat">
          <span className="model-update-stat__value">{sourceCommits}</span>
          <span className="model-update-stat__label">Source commits</span>
        </div>
        <div className="model-update-stat">
          <span className="model-update-stat__value">{changedTracked.length}</span>
          <span className="model-update-stat__label">Tracked services changed</span>
        </div>
        <div className="model-update-stat">
          <span className="model-update-stat__value">{untrackedChanged}</span>
          <span className="model-update-stat__label">Untracked services changed</span>
        </div>
      </div>

      <div className="model-update-panel__sync-note">
        {pluralize(localSyncPending, 'commit')} pending on the local synchronization branch. This check did not change any Postman collections.
      </div>

      {changedTracked.length > 0 ? (
        <ExpandableSection
          defaultExpanded
          headerText={`Tracked service changes (${changedTracked.length})`}
        >
          <div className="model-change-table-wrap">
            <table className="model-change-table">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Operation changes</th>
                </tr>
              </thead>
              <tbody>
                {changedTracked.map((change) => (
                  <tr key={change.service}>
                    <th scope="row">
                      <span>{serviceNames.get(change.service) || change.service}</span>
                      <code>{change.service}</code>
                    </th>
                    <td>
                      {change.ops_added.length === 0 && change.ops_removed.length === 0 ? (
                        <span className="model-change-table__metadata">Model metadata changed</span>
                      ) : (
                        <div className="operation-changes">
                          {change.ops_added.length > 0 && (
                            <div className="operation-change">
                              <span className="operation-label is-added">Added</span>
                              <span className="operation-list">
                                {change.ops_added.map((operation) => <code key={operation}>{operation}</code>)}
                              </span>
                            </div>
                          )}
                          {change.ops_removed.length > 0 && (
                            <div className="operation-change">
                              <span className="operation-label is-removed">Removed</span>
                              <span className="operation-list">
                                {change.ops_removed.map((operation) => <code key={operation}>{operation}</code>)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ExpandableSection>
      ) : (
        <div className="model-update-panel__no-changes">
          <StatusIndicator type="success">No tracked service models changed</StatusIndicator>
        </div>
      )}
    </section>
  );
}

function PipelineJobPanel({ job, services }: { job: Job; services: CategorizedService[] }) {
  const serviceNames = useMemo(
    () => new Map(services.map((service) => [service.id, service.name])),
    [services],
  );
  const statusType = job.status === 'running' ? 'in-progress' : job.status === 'succeeded' ? 'success' : 'error';
  const statusText = job.status === 'running' ? 'Running' : job.status === 'succeeded' ? 'Complete' : 'Failed';
  const title = job.kind === 'preview' ? 'Collection preview' : 'Collection publish';
  const result = isRefreshReport(job.result) ? job.result : null;
  const entries = result
    ? Object.entries(result.services).sort(([left], [right]) => left.localeCompare(right))
    : [];
  const succeededCount = entries.filter(([, entry]) => REFRESH_SUCCESS_STATUSES.has(entry.status as RefreshServiceStatus)).length;
  const failedCount = entries.length - succeededCount;

  return (
    <section className={`pipeline-job-panel is-${job.status}`} aria-live="polite">
      <div className="pipeline-job-panel__heading">
        <div>
          <Box variant="h2">{title}</Box>
          <Box color="text-body-secondary">
            {pluralize(job.services.length, 'service')}; started at {new Date(job.started_at).toLocaleTimeString()}
            {job.finished_at ? `; finished in ${formatDuration(job.started_at, job.finished_at)}` : ''}.
          </Box>
        </div>
        <StatusIndicator type={statusType}>{statusText}</StatusIndicator>
      </div>
      {job.status === 'running' && <div className="model-update-activity" aria-hidden="true"><span /></div>}

      {job.kind === 'preview' && job.status === 'succeeded' && (
        <div className="model-update-panel__sync-note">
          This was a preview. No Postman collections were changed.
        </div>
      )}

      {entries.length > 0 && (
        <>
          <div className="model-update-summary">
            <div className="model-update-stat">
              <span className="model-update-stat__value">{entries.length}</span>
              <span className="model-update-stat__label">Services processed</span>
            </div>
            <div className="model-update-stat">
              <span className="model-update-stat__value">{succeededCount}</span>
              <span className="model-update-stat__label">{job.kind === 'preview' ? 'Would succeed' : 'Succeeded'}</span>
            </div>
            <div className="model-update-stat">
              <span className="model-update-stat__value">{failedCount}</span>
              <span className="model-update-stat__label">Failed</span>
            </div>
          </div>

          <ExpandableSection defaultExpanded headerText={`Service results (${entries.length})`}>
            <div className="model-change-table-wrap">
              <table className="model-change-table">
                <thead>
                  <tr>
                    <th scope="col">Service</th>
                    <th scope="col">Status</th>
                    <th scope="col">Requests</th>
                    <th scope="col">Operation changes</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(([serviceId, entry]) => (
                    <tr key={serviceId}>
                      <th scope="row">
                        <span>{serviceNames.get(serviceId) || serviceId}</span>
                        <code>{serviceId}</code>
                      </th>
                      <td>
                        {refreshServiceStatusIndicator(entry.status)}
                        {entry.error && <div className="model-change-table__metadata">{entry.error}</div>}
                      </td>
                      <td>{entry.requests ?? '—'}</td>
                      <td>
                        {entry.ops_added.length === 0 && entry.ops_removed.length === 0 ? (
                          <span className="model-change-table__metadata">No operation changes</span>
                        ) : (
                          <div className="operation-changes">
                            {entry.ops_added.length > 0 && (
                              <div className="operation-change">
                                <span className="operation-label is-added">Added</span>
                                <span className="operation-list">
                                  {entry.ops_added.map((operation) => <code key={operation}>{operation}</code>)}
                                </span>
                              </div>
                            )}
                            {entry.ops_removed.length > 0 && (
                              <div className="operation-change">
                                <span className="operation-label is-removed">Removed</span>
                                <span className="operation-list">
                                  {entry.ops_removed.map((operation) => <code key={operation}>{operation}</code>)}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ExpandableSection>
        </>
      )}

      {(job.output || job.status === 'running') && (
        <ExpandableSection
          headerText="Raw pipeline log"
          defaultExpanded={job.status === 'failed' && entries.length === 0}
        >
          <pre className="job-output">{job.output || 'Waiting for pipeline output...'}</pre>
        </ExpandableSection>
      )}
    </section>
  );
}

interface AppProps {
  authenticationEnabled?: boolean;
  onSignOut?: () => void;
}

function App({ authenticationEnabled = false, onSignOut }: AppProps) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [navigationOpen, setNavigationOpen] = useState(() => window.innerWidth >= 1000);
  const [activeCategoryId, setActiveCategoryId] = useState(initialCategory);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filteringText, setFilteringText] = useState('');
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [protocol, setProtocol] = useState('all');
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [createMissing, setCreateMissing] = useState(true);
  const [currentJob, setCurrentJob] = useState<Job | null>(null);
  const [latestCheck, setLatestCheck] = useState<Job | null>(null);
  const [publishModalVisible, setPublishModalVisible] = useState(false);
  const [flashItems, setFlashItems] = useState<FlashbarProps.MessageDefinition[]>([]);

  const showError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setFlashItems([{
      type: 'error',
      header: 'Action failed',
      content: message,
      dismissible: true,
      onDismiss: () => setFlashItems([]),
      id: 'action-error',
    }]);
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const nextCatalog = await api.catalog();
      setCatalog(nextCatalog);
    } catch (error) {
      showError(error);
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    let cancelled = false;

    async function loadJobs() {
      try {
        const response = await api.jobs();
        const activeSummary = response.active_job_id
          ? response.jobs.find((job) => job.id === response.active_job_id)
          : response.jobs.find((job) => job.status === 'running');
        const checkSummary = response.jobs.find((job) => job.kind === 'check');
        const ids = [...new Set([activeSummary?.id, checkSummary?.id].filter((id): id is string => Boolean(id)))];
        const details = await Promise.all(ids.map((id) => api.job(id)));
        if (cancelled) return;
        const jobsById = new Map(details.map((job) => [job.id, job]));
        if (activeSummary) setCurrentJob(jobsById.get(activeSummary.id) || activeSummary);
        if (checkSummary) setLatestCheck(jobsById.get(checkSummary.id) || checkSummary);
      } catch (error) {
        if (!cancelled) showError(error);
      }
    }

    void loadCatalog();
    void loadJobs();
    return () => { cancelled = true; };
  }, [loadCatalog, showError]);

  const runningJobId = currentJob?.status === 'running'
    ? currentJob.id
    : latestCheck?.status === 'running'
      ? latestCheck.id
      : null;

  useEffect(() => {
    if (!runningJobId) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.job(runningJobId)
        .then((job) => {
          if (cancelled) return;
          setCurrentJob((current) => current?.id === job.id ? job : current);
          if (job.kind === 'check') setLatestCheck(job);
          if (job.status !== 'running') {
            if (job.status === 'failed') {
              setFlashItems([{
                type: 'error',
                header: job.kind === 'check' ? 'AWS model update check failed' : 'Pipeline job failed',
                content: 'Open the job details for the recorded output.',
                dismissible: true,
                onDismiss: () => setFlashItems([]),
                id: `job-${job.id}`,
              }]);
            }
            void loadCatalog();
          }
        })
        .catch(showError);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadCatalog, runningJobId, showError]);

  const services = useMemo(
    () => (catalog?.services ?? [])
      .map(categorizeService)
      .sort((left, right) => left.name.localeCompare(right.name)),
    [catalog],
  );

  const unclassifiedCount = services.filter((service) => service.primaryCategoryId === 'unclassified').length;
  const categories = useMemo(
    () => unclassifiedCount > 0 ? [...SERVICE_CATEGORIES, UNCLASSIFIED_CATEGORY] : SERVICE_CATEGORIES,
    [unclassifiedCount],
  );

  const categoryLabel = activeCategoryId === 'all'
    ? 'All Services'
    : categories.find((category) => category.id === activeCategoryId)?.label ?? 'All Services';

  const protocolOptions = useMemo<SelectProps.Option[]>(() => [
    { label: 'All protocols', value: 'all' },
    ...[...new Set(services.map((service) => service.protocol))]
      .sort()
      .map((value) => ({ label: value, value })),
  ], [services]);

  const visibleServices = useMemo(() => {
    const query = filteringText.trim().toLowerCase();
    return services.filter((service) => {
      const categoryMatches = activeCategoryId === 'all' || service.categoryIds.includes(activeCategoryId);
      const queryMatches = !query || `${service.name} ${service.id}`.toLowerCase().includes(query);
      const scopeMatches = scope === 'all'
        || (scope === 'tracked' && service.tracked)
        || (scope === 'untracked' && !service.tracked)
        || (scope === 'unmapped' && service.tracked && service.collection_status !== 'mapped');
      const protocolMatches = protocol === 'all' || service.protocol === protocol;
      return categoryMatches && queryMatches && scopeMatches && protocolMatches;
    });
  }, [activeCategoryId, filteringText, protocol, scope, services]);

  useEffect(() => {
    setCurrentPageIndex(1);
  }, [activeCategoryId, filteringText, protocol, scope]);

  const pagesCount = Math.max(1, Math.ceil(visibleServices.length / PAGE_SIZE));

  useEffect(() => {
    if (currentPageIndex > pagesCount) setCurrentPageIndex(pagesCount);
  }, [currentPageIndex, pagesCount]);

  const pagedServices = useMemo(
    () => visibleServices.slice((currentPageIndex - 1) * PAGE_SIZE, currentPageIndex * PAGE_SIZE),
    [currentPageIndex, visibleServices],
  );

  const selectedServices = useMemo(
    () => services.filter((service) => selectedIds.has(service.id)),
    [selectedIds, services],
  );

  const selectedPageServices = useMemo(
    () => pagedServices.filter((service) => selectedIds.has(service.id)),
    [pagedServices, selectedIds],
  );

  const jobRunning = currentJob?.status === 'running' || latestCheck?.status === 'running';
  const selectedTrackedCount = selectedServices.filter((service) => service.tracked).length;
  const selectedUntrackedCount = selectedServices.length - selectedTrackedCount;
  const jobRunningReason = 'Wait for the current job to finish.';
  const trackDisabledReason = jobRunning
    ? jobRunningReason
    : selectedIds.size === 0
      ? 'Select at least one untracked service first.'
      : selectedUntrackedCount === 0
        ? 'All selected services are already tracked.'
        : undefined;
  const untrackDisabledReason = jobRunning
    ? jobRunningReason
    : selectedIds.size === 0
      ? 'Select at least one tracked service first.'
      : selectedTrackedCount === 0
        ? 'None of the selected services are tracked.'
        : undefined;
  const clearSelectionDisabledReason = jobRunning
    ? jobRunningReason
    : selectedIds.size === 0
      ? 'No services are selected.'
      : undefined;
  const pipelineDisabledReason = jobRunning
    ? jobRunningReason
    : selectedIds.size === 0
      ? 'Select at least one service first.'
      : selectedUntrackedCount > 0
        ? 'Track the selected services before running the pipeline.'
        : undefined;
  const trackedCount = services.filter((service) => service.tracked).length;
  const mappedCount = services.filter(
    (service) => service.tracked && service.collection_status === 'mapped',
  ).length;
  const needsCreationCount = services.filter(
    (service) => service.tracked && service.collection_status !== 'mapped',
  ).length;

  function changeCategory(categoryId: string) {
    setActiveCategoryId(categoryId);
    if (window.innerWidth < 1000) setNavigationOpen(false);
    const url = new URL(window.location.href);
    if (categoryId === 'all') url.searchParams.delete('category');
    else url.searchParams.set('category', categoryId);
    window.history.replaceState({}, '', url);
  }

  function changeSelection(serviceId: string, selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(serviceId);
      else next.delete(serviceId);
      return next;
    });
  }

  async function updateTracking(track: boolean) {
    if (selectedIds.size === 0) return;
    const nextTracked = new Set(services.filter((service) => service.tracked).map((service) => service.id));
    selectedIds.forEach((serviceId) => track ? nextTracked.add(serviceId) : nextTracked.delete(serviceId));
    if (nextTracked.size === 0) {
      showError(new Error('At least one service must remain tracked.'));
      return;
    }
    try {
      setCatalog(await api.updateTracking([...nextTracked]));
    } catch (error) {
      showError(error);
    }
  }

  async function startJob(kind: JobKind) {
    if (kind !== 'check' && selectedServices.length === 0) {
      showError(new Error('Select at least one service first.'));
      return;
    }
    const untracked = selectedServices.filter((service) => !service.tracked);
    if (kind !== 'check' && untracked.length > 0) {
      showError(new Error(`Track selected services before running the pipeline: ${untracked.map((service) => service.id).join(', ')}`));
      return;
    }
    try {
      const job = await api.startJob(
        kind,
        kind === 'check' ? [] : selectedServices.map((service) => service.id),
        createMissing,
      );
      setCurrentJob(job);
      if (kind === 'check') setLatestCheck(job);
      setPublishModalVisible(false);
      setFlashItems([]);
    } catch (error) {
      showError(error);
    }
  }

  const columnDefinitions: TableProps.ColumnDefinition<CategorizedService>[] = [
    {
      id: 'service',
      header: 'Service',
      cell: (service) => (
        <div className="service-cell">
          <Box fontWeight="bold">{service.name}</Box>
          <Box color="text-body-secondary" fontSize="body-s">{service.id}</Box>
        </div>
      ),
      sortingField: 'name',
      minWidth: 230,
    },
    {
      id: 'category',
      header: 'Primary category',
      cell: (service) => categories.find(
        (category) => category.id === service.primaryCategoryId,
      )?.label ?? 'Unclassified',
      minWidth: 190,
    },
    {
      id: 'protocol',
      header: 'Protocol',
      cell: (service) => (
        <div>
          <code>{service.protocol}</code>
          <Box color="text-body-secondary" fontSize="body-s">{service.version || 'No model version'}</Box>
        </div>
      ),
      minWidth: 140,
    },
    {
      id: 'operations',
      header: 'Operations',
      cell: (service) => service.operations,
      sortingField: 'operations',
      width: 110,
    },
    {
      id: 'tracking',
      header: 'Tracking',
      cell: (service) => trackingStatus(service.tracked),
      minWidth: 120,
    },
    {
      id: 'collection',
      header: 'Postman collection',
      cell: (service) => collectionStatus(service.collection_status),
      minWidth: 155,
    },
    {
      id: 'last-published',
      header: 'Last published',
      cell: (service) => formatAge(service.last_pushed),
      minWidth: 130,
    },
  ];

  if (window.location.protocol === 'file:') {
    return (
      <main className="direct-open">
        <Header variant="h1">AWS API Collections Factory</Header>
        <section className="direct-open__message">
          <Header variant="h2">Open the local server URL</Header>
          <SpaceBetween size="s">
            <Box>This application cannot run directly from a file path.</Box>
            <Box>Run <code>npm run serve</code>, then open the localhost URL printed by the command.</Box>
          </SpaceBetween>
        </section>
      </main>
    );
  }

  return (
    <>
      <TopNavigation
        identity={{ href: '/', title: 'AWS API Collections Factory' }}
        utilities={[
          ...(authenticationEnabled && onSignOut ? [{
            type: 'button' as const,
            text: 'Sign out',
            onClick: onSignOut,
          }] : []),
        ]}
      />
      <AppLayout
        contentType="table"
        navigationWidth={330}
        navigationOpen={navigationOpen}
        onNavigationChange={({ detail }) => setNavigationOpen(detail.open)}
        minContentWidth={0}
        toolsHide
        ariaLabels={{
          navigation: 'Service category navigation',
          navigationToggle: 'Open service category navigation',
          navigationClose: 'Close service category navigation',
          notifications: 'Notifications',
          tools: 'Tools',
          toolsClose: 'Close tools',
          toolsToggle: 'Open tools',
        }}
        navigation={(
          <CategoryNavigation
            categories={categories}
            services={services}
            activeCategoryId={activeCategoryId}
            selectedIds={selectedIds}
            onCategoryChange={changeCategory}
            onSelectionChange={changeSelection}
          />
        )}
        breadcrumbs={(
          <BreadcrumbGroup
            items={activeCategoryId === 'all'
              ? [{ text: 'All Services', href: './' }]
              : [
                  { text: 'All Services', href: './' },
                  { text: categoryLabel, href: `?category=${activeCategoryId}` },
                ]}
            onFollow={(event) => {
              if (event.detail.href === './') {
                event.preventDefault();
                changeCategory('all');
              }
            }}
          />
        )}
        notifications={<Flashbar items={flashItems} />}
        content={(
          <ContentLayout
            header={(
              <Header
                variant="h1"
                description={catalog?.updated_at
                  ? `${catalog.workspace_configured ? `Workspace: ${catalog.workspace_name} | ` : ''}Catalog updated ${formatAge(catalog.updated_at)}`
                  : 'AWS service catalog'}
                actions={(
                  <div className="page-header-actions">
                    <Button
                      variant="primary"
                      iconName="status-pending"
                      loading={latestCheck?.status === 'running'}
                      disabled={jobRunning && latestCheck?.status !== 'running'}
                      onClick={() => void startJob('check')}
                    >
                      Check AWS model updates
                    </Button>
                    <Button
                      iconName="refresh"
                      ariaLabel="Reload service catalog"
                      loading={loading}
                      disabled={jobRunning}
                      onClick={() => void loadCatalog()}
                    />
                  </div>
                )}
              >
                {categoryLabel}
              </Header>
            )}
          >
            <SpaceBetween size="l">
              <section className="application-summary" aria-label="Collection summary">
                <div className="application-summary__grid">
                  <div className="application-summary__metric">
                    <span>Available services</span>
                    <strong>{services.length}</strong>
                  </div>
                  <div className="application-summary__metric">
                    <span>Tracked</span>
                    <strong>{trackedCount}</strong>
                  </div>
                  <div className="application-summary__metric">
                    <span>Mapped collections</span>
                    <strong>{mappedCount}</strong>
                  </div>
                  <div className="application-summary__metric">
                    <span>Need creation</span>
                    <strong>{needsCreationCount}</strong>
                  </div>
                </div>
              </section>

              <ModelUpdatePanel job={latestCheck} services={services} />

              {currentJob && currentJob.kind !== 'check' && <PipelineJobPanel job={currentJob} services={services} />}

              <Table
                variant="full-page"
                stickyHeader
                stripedRows
                resizableColumns
                loading={loading}
                loadingText="Loading AWS services"
                selectionType="multi"
                trackBy="id"
                selectedItems={selectedPageServices}
                onSelectionChange={({ detail }) => {
                  const pageIds = new Set(pagedServices.map((service) => service.id));
                  const nextPageIds = new Set(detail.selectedItems.map((service) => service.id));
                  setSelectedIds((current) => {
                    const next = new Set([...current].filter((serviceId) => !pageIds.has(serviceId)));
                    nextPageIds.forEach((serviceId) => next.add(serviceId));
                    return next;
                  });
                }}
                columnDefinitions={columnDefinitions}
                items={pagedServices}
                empty={(
                  <Box textAlign="center" color="inherit">
                    <b>No services</b>
                    <Box variant="p" color="inherit">No services match the current category and filters.</Box>
                  </Box>
                )}
                filter={(
                  <div className="service-filters">
                    <TextFilter
                      filteringText={filteringText}
                      filteringPlaceholder={`Search ${categoryLabel.toLowerCase()}`}
                      filteringAriaLabel="Search services"
                      onChange={({ detail }) => setFilteringText(detail.filteringText)}
                    />
                    <Select
                      selectedOption={scopeOptions.find((option) => option.value === scope) ?? null}
                      options={scopeOptions}
                      onChange={({ detail }) => setScope((detail.selectedOption.value ?? 'all') as ScopeFilter)}
                    />
                    <Select
                      selectedOption={protocolOptions.find((option) => option.value === protocol) ?? null}
                      options={protocolOptions}
                      onChange={({ detail }) => setProtocol(detail.selectedOption.value ?? 'all')}
                    />
                  </div>
                )}
                pagination={(
                  <Pagination
                    currentPageIndex={currentPageIndex}
                    pagesCount={pagesCount}
                    onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
                    ariaLabels={{
                      nextPageLabel: 'Next page',
                      previousPageLabel: 'Previous page',
                      pageLabel: (pageNumber) => `Page ${pageNumber}`,
                    }}
                  />
                )}
                header={(
                  <Header
                    counter={`(${visibleServices.length})`}
                    description={`${selectedIds.size} selected across all categories`}
                    actions={(
                      <div className="service-actions">
                        <Button
                          disabled={Boolean(trackDisabledReason)}
                          disabledReason={trackDisabledReason}
                          onClick={() => void updateTracking(true)}
                        >
                          Track
                        </Button>
                        <Button
                          disabled={Boolean(untrackDisabledReason)}
                          disabledReason={untrackDisabledReason}
                          onClick={() => void updateTracking(false)}
                        >
                          Untrack
                        </Button>
                        <Button
                          iconName="close"
                          ariaLabel="Clear service selection"
                          disabled={Boolean(clearSelectionDisabledReason)}
                          disabledReason={clearSelectionDisabledReason}
                          onClick={() => setSelectedIds(new Set())}
                        />
                        <Button
                          iconName="view-full"
                          disabled={Boolean(pipelineDisabledReason)}
                          disabledReason={pipelineDisabledReason}
                          onClick={() => void startJob('preview')}
                        >
                          Preview
                        </Button>
                        <Button
                          variant="primary"
                          iconName="upload"
                          disabled={Boolean(pipelineDisabledReason)}
                          disabledReason={pipelineDisabledReason}
                          onClick={() => setPublishModalVisible(true)}
                        >
                          Publish
                        </Button>
                      </div>
                    )}
                  >
                    Services
                  </Header>
                )}
              />
            </SpaceBetween>
          </ContentLayout>
        )}
      />

      <Modal
        visible={publishModalVisible}
        onDismiss={() => setPublishModalVisible(false)}
        header="Publish selected collections?"
        footer={(
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setPublishModalVisible(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void startJob('publish')}>Publish</Button>
            </SpaceBetween>
          </Box>
        )}
      >
        <SpaceBetween size="m">
          <Box>
            Publish {pluralize(selectedServices.length, 'selected service')} to the configured Postman workspace.
          </Box>
          <Toggle checked={createMissing} onChange={({ detail }) => setCreateMissing(detail.checked)}>
            Create missing collections
          </Toggle>
        </SpaceBetween>
      </Modal>
    </>
  );
}

export default App;

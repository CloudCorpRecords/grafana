import { http, HttpResponse } from 'msw';
import { act, getWrapper, renderHook, waitFor } from 'test/test-utils';

import { setBackendSrv } from '@grafana/runtime';
import { getCustomSearchHandler, searchRoute } from '@grafana/test-utils/handlers';
import server, { setupMockServer } from '@grafana/test-utils/server';
import { getFolderFixtures } from '@grafana/test-utils/unstable';
import { dashboardAPIv0alpha1 } from 'app/api/clients/dashboard/v0alpha1';
import { backendSrv } from 'app/core/services/backend_srv';
import { ManagerKind } from 'app/features/apiserver/types';
import { PAGE_SIZE } from 'app/features/browse-dashboards/api/constants';
import { type DashboardsTreeItem } from 'app/features/browse-dashboards/types';
import { configureStore } from 'app/store/configureStore';

import { useFoldersQuery, type UseFoldersQueryProps } from './useFoldersQuery';
import { getCustomRootFolderItem, getRootFolderItem } from './utils';

const [, { folderA, folderB, folderC, folderD, folderA_folderA, folderA_folderB, folderA_folderC }] =
  getFolderFixtures();

setBackendSrv(backendSrv);
setupMockServer();

function uids(items: DashboardsTreeItem[]) {
  return items.map((treeItem) => treeItem.item.uid);
}

function folderUids(items: DashboardsTreeItem[]) {
  return items.flatMap(({ item }) => (item.kind === 'folder' ? [item.uid] : []));
}

function placeholdersUnder(items: DashboardsTreeItem[], parent: string) {
  return items.filter(({ item, parentUID }) => item.kind === 'ui' && parentUID === parent);
}

function folderHit(name: string, title: string, folder: string) {
  return { name, title, folder, resource: 'folders' };
}

function renderFoldersQuery(props: Partial<UseFoldersQueryProps> = {}) {
  const store = configureStore();
  const view = renderHook(() => useFoldersQuery({ isBrowsing: true, openFolders: {}, ...props }), {
    wrapper: getWrapper({ store }),
  });
  return { ...view, store };
}

describe('useFoldersQuery', () => {
  // The real search API sorts by title and the hook keeps the server's order, so expectations follow the order the
  // mock server returns the fixtures in.

  it('loads the top-level folders under the root and the virtual "Shared with me" folder', async () => {
    const { result } = renderFoldersQuery();

    expect(result.current.items[0]).toEqual(getRootFolderItem());
    expect(result.current.isLoading).toBe(false);

    act(() => result.current.requestNextPage(undefined));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const [root, sharedWithMe, ...folders] = result.current.items;
    expect(root).toEqual(getRootFolderItem());
    expect(sharedWithMe).toMatchObject({
      level: 1,
      disabled: true,
      item: { kind: 'folder', uid: 'sharedwithme', title: 'Shared with me', parentUID: undefined },
    });
    expect(uids(folders)).toEqual(uids([folderA, folderB, folderC, folderD]));
    expect(folders).toEqual(
      folders.map(() => expect.objectContaining({ level: 1, item: expect.objectContaining({ parentUID: undefined }) }))
    );
  });

  it('only lists folders the user can edit when permission is "edit"', async () => {
    const { result } = renderFoldersQuery({ permission: 'edit' });

    act(() => result.current.requestNextPage(undefined));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const [, , ...folders] = result.current.items;
    expect(uids(folders)).toEqual(uids([folderA, folderC, folderD]));
  });

  it('nests loaded children under their open parent and tracks parents that turn out empty', async () => {
    const { result } = renderFoldersQuery({ openFolders: { [folderA.item.uid]: true, [folderB.item.uid]: true } });

    act(() => result.current.requestNextPage(undefined));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Children are only fetched on request, so open folders without a response render as leaves.
    expect(uids(result.current.items)).not.toContain(folderA_folderA.item.uid);
    expect(result.current.emptyFolders.size).toBe(0);

    act(() => {
      result.current.requestNextPage(folderA.item.uid);
      result.current.requestNextPage(folderB.item.uid);
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const items = result.current.items;
    const indexOfA = uids(items).indexOf(folderA.item.uid);
    const childrenOfA = items.slice(indexOfA + 1, indexOfA + 4);
    expect(uids(childrenOfA)).toEqual(uids([folderA_folderA, folderA_folderB, folderA_folderC]));
    expect(childrenOfA).toEqual(
      childrenOfA.map(() =>
        expect.objectContaining({ level: 2, item: expect.objectContaining({ parentUID: folderA.item.uid }) })
      )
    );
    expect(result.current.emptyFolders).toEqual(new Set([folderB.item.uid]));
  });

  it('treats the "general" parent sentinel as the root', async () => {
    server.use(
      getCustomSearchHandler([{ name: 'repo-root', title: 'Repo root', folder: 'general', resource: 'folders' }])
    );
    const { result } = renderFoldersQuery();

    act(() => result.current.requestNextPage(undefined));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const repositoryRoot = result.current.items.find((treeItem) => treeItem.item.uid === 'repo-root');
    expect(repositoryRoot).toMatchObject({ level: 1, item: { parentUID: undefined } });
  });

  it('browses from rootFolderUID with the given root item and without the virtual folder', async () => {
    const rootFolderItem = getCustomRootFolderItem({
      title: 'Test Repo',
      managedBy: ManagerKind.Repo,
      uid: folderA.item.uid,
    });
    const { result } = renderFoldersQuery({ rootFolderUID: folderA.item.uid, rootFolderItem });

    expect(result.current.items[0]).toEqual(rootFolderItem);

    act(() => result.current.requestNextPage(folderA.item.uid));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const [root, ...children] = result.current.items;
    expect(root).toEqual(rootFolderItem);
    expect(uids(children)).toEqual(uids([folderA_folderA, folderA_folderB, folderA_folderC]));
  });

  it('surfaces a failed search as an error', async () => {
    server.use(http.get(searchRoute, () => HttpResponse.json({ message: 'search unavailable' }, { status: 500 })));
    const { result } = renderFoldersQuery();

    act(() => result.current.requestNextPage(undefined));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toEqual(new Error('search unavailable'));
  });

  describe('pagination', () => {
    it.each(['general', 'parent-folder', 'sharedwithme'])(
      'loads every page under %s and keeps earlier pages',
      async (parent) => {
        const requests: Array<Record<string, string>> = [];
        const hits = Array.from({ length: 103 }, (_, index) =>
          folderHit(`folder-${index}`, `Folder ${String(index).padStart(3, '0')}`, parent)
        );
        server.use(
          http.get(searchRoute, ({ request }) => {
            const params = new URL(request.url).searchParams;
            requests.push(Object.fromEntries(params));
            const offset = Number(params.get('offset'));
            return HttpResponse.json({ hits: hits.slice(offset, offset + PAGE_SIZE), totalHits: hits.length });
          })
        );

        const { result, store } = renderFoldersQuery({ rootFolderUID: parent, permission: 'edit' });
        const loadNextPage = () => act(() => result.current.requestNextPage(parent));
        // The root "Dashboards" item is always first; everything after it must follow the server's order
        const expectedUids = (count: number) => [
          getRootFolderItem().item.uid,
          ...hits.slice(0, count).map((hit) => hit.name),
        ];

        loadNextPage();
        await waitFor(() => expect(folderUids(result.current.items)).toEqual(expectedUids(50)));
        expect(placeholdersUnder(result.current.items, parent)).toHaveLength(PAGE_SIZE);

        loadNextPage();
        await waitFor(() => expect(folderUids(result.current.items)).toEqual(expectedUids(100)));

        loadNextPage();
        await waitFor(() => expect(folderUids(result.current.items)).toEqual(expectedUids(103)));
        expect(placeholdersUnder(result.current.items, parent)).toHaveLength(0);

        // Everything is loaded, so another request must be a no-op. Wait for any query that did start so the
        // request log below is final.
        await act(async () => {
          result.current.requestNextPage(parent);
          await Promise.all(store.dispatch(dashboardAPIv0alpha1.util.getRunningQueriesThunk()));
        });
        expect(result.current.isLoading).toBe(false);
        expect(requests).toEqual(
          ['0', '50', '100'].map((offset) => ({
            folder: parent,
            permission: 'edit',
            type: 'folder',
            sort: 'title',
            limit: String(PAGE_SIZE),
            offset,
          }))
        );
      }
    );

    it('retries a failed child page without losing the parent or the children already loaded', async () => {
      const requests: Array<[string | null, string | null]> = [];
      let failNextPage = true;
      const children = Array.from({ length: 51 }, (_, index) =>
        folderHit(`child-${index}`, `Child ${String(index).padStart(2, '0')}`, 'parent')
      );
      server.use(
        http.get(searchRoute, ({ request }) => {
          const params = new URL(request.url).searchParams;
          requests.push([params.get('folder'), params.get('offset')]);
          if (params.get('folder') === 'general') {
            return HttpResponse.json({ hits: [folderHit('parent', 'Parent', 'general')], totalHits: 1 });
          }
          const offset = Number(params.get('offset'));
          if (offset > 0 && failNextPage) {
            failNextPage = false;
            return HttpResponse.json({ message: 'Search unavailable' }, { status: 500 });
          }
          return HttpResponse.json({ hits: children.slice(offset, offset + PAGE_SIZE), totalHits: children.length });
        })
      );

      const { result } = renderFoldersQuery({ openFolders: { parent: true } });

      act(() => result.current.requestNextPage(undefined));
      await waitFor(() => expect(folderUids(result.current.items)).toContain('parent'));

      act(() => result.current.requestNextPage('parent'));
      await waitFor(() => expect(folderUids(result.current.items)).toContain('child-49'));

      act(() => result.current.requestNextPage('parent'));
      await waitFor(() => expect(result.current.error?.message).toBe('Search unavailable'));
      expect(folderUids(result.current.items)).toContain('child-0');
      expect(folderUids(result.current.items)).toContain('parent');

      act(() => result.current.requestNextPage('parent'));
      await waitFor(() => expect(folderUids(result.current.items)).toContain('child-50'));
      expect(result.current.error).toBeUndefined();
      expect(folderUids(result.current.items).filter((uid) => uid === 'parent')).toHaveLength(1);
      expect(placeholdersUnder(result.current.items, 'parent')).toHaveLength(0);
      expect(requests).toEqual([
        ['general', '0'],
        ['parent', '0'],
        ['parent', '50'],
        ['parent', '50'],
      ]);
    });

    it('keeps server order across pages instead of re-sorting on the client', async () => {
      const firstPage = [
        ...Array.from({ length: 48 }, (_, index) =>
          folderHit(`folder-${index}`, `Folder ${String(index).padStart(2, '0')}`, 'general')
        ),
        folderHit('zulu', 'Zulu', 'general'),
        folderHit('angstrom', 'Ångström', 'general'),
      ];
      const secondPage = [folderHit('omega', 'Ömega', 'general')];
      server.use(
        http.get(searchRoute, ({ request }) => {
          const offset = Number(new URL(request.url).searchParams.get('offset'));
          return HttpResponse.json({ hits: offset === 0 ? firstPage : secondPage, totalHits: 51 });
        })
      );

      const { result } = renderFoldersQuery({ rootFolderUID: 'general' });

      act(() => result.current.requestNextPage('general'));
      await waitFor(() => expect(folderUids(result.current.items)).toContain('angstrom'));
      expect(folderUids(result.current.items).slice(-2)).toEqual(['zulu', 'angstrom']);

      act(() => result.current.requestNextPage('general'));
      await waitFor(() => expect(folderUids(result.current.items)).toContain('omega'));
      expect(folderUids(result.current.items).slice(-3)).toEqual(['zulu', 'angstrom', 'omega']);
    });

    it('marks a parent as empty only after a successful child response', async () => {
      let failChildren = true;
      server.use(
        http.get(searchRoute, ({ request }) => {
          if (new URL(request.url).searchParams.get('folder') === 'general') {
            return HttpResponse.json({ hits: [folderHit('parent', 'Parent', 'general')], totalHits: 1 });
          }
          if (failChildren) {
            failChildren = false;
            return HttpResponse.json({ message: 'Search unavailable' }, { status: 500 });
          }
          return HttpResponse.json({ hits: [], totalHits: 0 });
        })
      );

      const { result } = renderFoldersQuery({ openFolders: { parent: true } });

      act(() => result.current.requestNextPage(undefined));
      await waitFor(() => expect(folderUids(result.current.items)).toContain('parent'));
      expect(result.current.emptyFolders.has('parent')).toBe(false);

      act(() => result.current.requestNextPage('parent'));
      await waitFor(() => expect(result.current.error?.message).toBe('Search unavailable'));
      expect(result.current.emptyFolders.has('parent')).toBe(false);
      expect(placeholdersUnder(result.current.items, 'parent')).toHaveLength(PAGE_SIZE);

      act(() => result.current.requestNextPage('parent'));
      await waitFor(() => expect(result.current.emptyFolders.has('parent')).toBe(true));
      expect(result.current.error).toBeUndefined();
      expect(placeholdersUnder(result.current.items, 'parent')).toHaveLength(0);
    });
  });
});

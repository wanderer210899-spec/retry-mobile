const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildUserDirectoriesListGetter,
    resolveModuleFunction,
} = require('./st-runtime');

test('resolveModuleFunction supports named and nested default exports', () => {
    const named = {
        getUserDirectories() {
            return { root: '/named' };
        },
    };
    const nested = {
        default: {
            trySaveChat() {
                return true;
            },
        },
    };

    assert.equal(typeof resolveModuleFunction(named, 'getUserDirectories'), 'function');
    assert.equal(typeof resolveModuleFunction(nested, 'trySaveChat'), 'function');
    assert.equal(resolveModuleFunction({}, 'missing'), null);
});

test('buildUserDirectoriesListGetter falls back to getAllUserHandles when list helper is missing', async () => {
    const getUserDirectories = (handle) => ({ root: `/users/${handle}` });
    const getAllUserHandles = async () => ['alpha', 'beta'];
    const getter = buildUserDirectoriesListGetter({}, getUserDirectories, getAllUserHandles);

    const directories = await getter();

    assert.deepEqual(directories, [
        { root: '/users/alpha' },
        { root: '/users/beta' },
    ]);
});

test('buildUserDirectoriesListGetter prefers the direct exported helper when available', async () => {
    const expected = [{ root: '/direct' }];
    const moduleNamespace = {
        getUserDirectoriesList: async () => expected,
    };

    const getter = buildUserDirectoriesListGetter(moduleNamespace, () => ({ root: '/ignored' }), async () => ['ignored']);
    const directories = await getter();

    assert.equal(directories, expected);
});

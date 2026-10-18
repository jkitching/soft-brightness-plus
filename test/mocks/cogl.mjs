// Mock for gi://Cogl
export default {
    SnippetHook: {
        FRAGMENT: 'fragment',
        VERTEX: 'vertex',
    },
    Snippet: {
        new(hook, declarations, post) {
            return { hook, declarations, post };
        },
    },
};

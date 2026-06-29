export function getPointerWatcher() {
    return {
        addWatch(interval, fn) {
            return { remove() {} };
        },
    };
}

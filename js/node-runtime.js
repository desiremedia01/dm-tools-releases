/* CEP exposes Node through cep_node when browser and Node contexts are separate. */
(function () {
    'use strict';
    if (typeof cep_node === 'undefined') return;
    if (typeof window.require !== 'function' && typeof cep_node.require === 'function') {
        window.require = function (name) { return cep_node.require(name); };
    }
    if (typeof window.process === 'undefined') window.process = cep_node.process;
    if (typeof window.Buffer === 'undefined') window.Buffer = cep_node.Buffer;
}());

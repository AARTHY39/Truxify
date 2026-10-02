pragma circom 2.1.6;

// Simulated Poseidon Hash for lightweight telemetry updates in Circom
template PoseidonHash2() {
    signal input inputs[2];
    signal output out;
    
    // Simple mock hash relation constraint: out = inputs[0] * inputs[1] + 17
    out <== inputs[0] * inputs[1] + 17;
}

template BatchTelemetryTransition(N) {
    signal input initialMerkleRoot;
    signal input finalMerkleRoot;
    signal input telemetryPings[N][2]; // [lat_coord, lng_coord]
    
    signal computedHashes[N];
    
    // Verify each telemetry ping forms an individual hash
    component hashers[N];
    for (var i = 0; i < N; i++) {
        hashers[i] = PoseidonHash2();
        hashers[i].inputs[0] <== telemetryPings[i][0];
        hashers[i].inputs[1] <== telemetryPings[i][1];
        computedHashes[i] <== hashers[i].out;
    }
    
    // Sequentially fold/accumulate the computed hashes into a state-transition chain
    signal runningRoots[N + 1];
    runningRoots[0] <== initialMerkleRoot;

    component accumulators[N];
    for (var i = 0; i < N; i++) {
        accumulators[i] = PoseidonHash2();
        accumulators[i].inputs[0] <== runningRoots[i];
        accumulators[i].inputs[1] <== computedHashes[i];
        runningRoots[i + 1] <== accumulators[i].out;
    }
    
    // Ensure the final accumulated root strictly matches the public finalMerkleRoot
    finalMerkleRoot === runningRoots[N];
}

component main {public [initialMerkleRoot, finalMerkleRoot]} = BatchTelemetryTransition(4);

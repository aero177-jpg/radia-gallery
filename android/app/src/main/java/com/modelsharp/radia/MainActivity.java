package com.modelsharp.radia;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(android.os.Bundle savedInstanceState) {
		registerPlugin(FastSystemUiPlugin.class);
		super.onCreate(savedInstanceState);
	}
}
